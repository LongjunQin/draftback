import Foundation

/// 与回稿本地服务(server.js)说话:取待推送队列、取正文与附件、报推送结果、送批次、报回执、心跳。
/// 端口从数据目录的 port 文件读(与 mdreview CLI 同一套规矩);服务不在时所有调用抛错,主循环下一轮再试。
struct ServerClient {
    let dataDir: URL
    private let session: URLSession

    init(dataDir: URL) {
        self.dataDir = dataDir
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        session = URLSession(configuration: config)
    }

    enum ClientError: Error, CustomStringConvertible {
        case serviceDown
        case http(Int, String)
        case badPayload(String)
        var description: String {
            switch self {
            case .serviceDown: return "回稿本地服务未运行"
            case .http(let status, let body): return "HTTP \(status): \(body.prefix(200))"
            case .badPayload(let why): return "响应无法解析: \(why)"
            }
        }
    }

    private func baseURL() throws -> URL {
        let portFile = dataDir.appendingPathComponent("port")
        guard let text = try? String(contentsOf: portFile, encoding: .utf8),
              let port = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)), port > 0 else {
            throw ClientError.serviceDown
        }
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.badPayload("非 HTTP 响应") }
        return (data, http)
    }

    func getJSON(_ path: String) async throws -> [String: Any] {
        let url = try baseURL().appendingPathComponent(path).absoluteString
        let request = URLRequest(url: URL(string: url)!)
        let (data, http) = try await perform(request)
        guard (200..<300).contains(http.statusCode) else { throw ClientError.http(http.statusCode, String(decoding: data, as: UTF8.self)) }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientError.badPayload("不是 JSON 对象") }
        return object
    }

    /// path 里已带查询串时用这个(appendingPathComponent 会把 ? 转义)
    func getJSON(rawPath: String) async throws -> [String: Any] {
        let request = URLRequest(url: URL(string: try baseURL().absoluteString + rawPath)!)
        let (data, http) = try await perform(request)
        guard (200..<300).contains(http.statusCode) else { throw ClientError.http(http.statusCode, String(decoding: data, as: UTF8.self)) }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientError.badPayload("不是 JSON 对象") }
        return object
    }

    func getData(rawPath: String) async throws -> Data {
        let request = URLRequest(url: URL(string: try baseURL().absoluteString + rawPath)!)
        let (data, http) = try await perform(request)
        guard (200..<300).contains(http.statusCode) else { throw ClientError.http(http.statusCode, String(decoding: data, as: UTF8.self)) }
        return data
    }

    @discardableResult
    func postJSON(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: try baseURL().absoluteString + path)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, http) = try await perform(request)
        guard (200..<300).contains(http.statusCode) else { throw ClientError.http(http.statusCode, String(decoding: data, as: UTF8.self)) }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    // MARK: 业务接口

    func outbox() async throws -> [[String: Any]] {
        (try await getJSON("/api/app/sync/outbox")["items"] as? [[String: Any]]) ?? []
    }
    func pushPayload(reviewId: String) async throws -> [String: Any] {
        try await getJSON(rawPath: "/api/app/sync/document?r=\(reviewId.urlQueryEncoded)")
    }
    func attachment(reviewId: String, relPath: String) async throws -> Data {
        try await getData(rawPath: "/api/app/file?r=\(reviewId.urlQueryEncoded)&path=\(relPath.urlQueryEncoded)")
    }
    func markPushed(reviewId: String, signature: String, contentHash: String) async throws {
        try await postJSON("/api/app/sync/pushed", ["reviewId": reviewId, "signature": signature, "contentHash": contentHash])
    }
    func markPushError(reviewId: String, error: String) async throws {
        try await postJSON("/api/app/sync/error", ["reviewId": reviewId, "error": error])
    }
    /// 云端记录的 revision 比本地要发的新(迟到的发布):本次作废、抬高水位,不再重试
    func markPushSuperseded(reviewId: String, cloudRevision: Int, signature: String) async throws {
        try await postJSON("/api/app/sync/superseded", ["reviewId": reviewId, "cloudRevision": cloudRevision, "signature": signature])
    }
    func importBatch(_ batch: [String: Any]) async throws -> [String: Any] {
        try await postJSON("/api/app/sync/batch", ["batch": batch])
    }
    func markReceiptSent(reviewId: String, batchId: String) async throws {
        try await postJSON("/api/app/sync/receipt-sent", ["reviewId": reviewId, "batchId": batchId])
    }
    /// 云端容器换了(改名):让本地服务把所有参与同步的文档重新排进待推送队列
    func resetPushes() async throws -> [String: Any] {
        try await postJSON("/api/app/sync/reset", [:])
    }
    /// 云端清理:定稿或作废满 30 天的文档清单;删完报回去
    func cleanupList() async throws -> [[String: Any]] {
        (try await getJSON("/api/app/sync/cleanup")["items"] as? [[String: Any]]) ?? []
    }
    func markCloudCleaned(reviewId: String) async throws {
        _ = try await postJSON("/api/app/sync/cleaned", ["reviewId": reviewId])
    }
    func heartbeat(_ state: [String: Any]) async throws {
        try await postJSON("/api/app/sync/heartbeat", state)
    }
}

extension String {
    var urlQueryEncoded: String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? self
    }
}
