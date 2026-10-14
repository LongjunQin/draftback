import Foundation
import CryptoKit

/// 批注记录:字段与 Mac 端 sidecar(<文档>.md.annotations.json)完全一致,
/// 未知字段原样保留(raw),这样手机上的批注批次回到 Mac 时不丢信息。
struct Note: Identifiable, Equatable {
    var raw: [String: Any]

    var id: String { raw["id"] as? String ?? "" }
    var comment: String { raw["comment"] as? String ?? "" }
    var quote: String { raw["quote"] as? String ?? "" }
    var status: String { (raw["status"] as? String ?? "open").lowercased() }
    var createdAt: String { raw["createdAt"] as? String ?? "" }
    var isOpen: Bool { status == "open" }
    /// 已打包导出 / 已上传、等 Mac 接收(跨端规则 6.2:提交即锁定,不能再改)。
    var isSubmitted: Bool { status == "submitted" }
    /// Mac 已接收(回执到达,批注已进 sidecar)。
    var isReceived: Bool { status == "received" }
    /// Mac 拒收(会话已推进 / 版本不一致),保留在手机上,由用户决定下一轮是否重提(跨端规则 6.6)。
    var isRejected: Bool { status == "rejected" }
    var rejectedReason: String? { raw["rejectedReason"] as? String }
    var submittedBatchId: String? { raw["submittedBatchId"] as? String }
    var baseVersion: String? { raw["baseVersion"] as? String }
    /// 创建时固定的轮次身份(跨端规则 v2.3 第 6.1 条):打包按它走,不取当前会话身份覆盖
    var docId: String? { raw["docId"] as? String }
    var reviewId: String? { raw["reviewId"] as? String }
    /// 批注是否属于这一轮:正文指纹对得上,且(Mac 推来的文档)轮次身份也对得上;没有轮次身份的旧批注不算当前轮
    func belongs(toVersion hash: String, reviewId current: String? = nil) -> Bool {
        guard let baseVersion else { return current == nil } // 没有指纹的旧数据:只在本地独立文件里按当前版本对待
        guard baseVersion == hash else { return false }
        guard let current else { return true }
        return reviewId == current
    }
    var isDocumentScope: Bool { (raw["scope"] as? String) == "document" }
    var headingPath: [String] { raw["headingPath"] as? [String] ?? [] }

    static func == (lhs: Note, rhs: Note) -> Bool {
        lhs.id == rhs.id && lhs.comment == rhs.comment && lhs.status == rhs.status
    }

    static func make(anchor: [String: Any]?, quote: String, comment: String, scope: String?) -> Note {
        var raw: [String: Any] = anchor ?? [:]
        raw["id"] = "n\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24))"
        raw["comment"] = comment
        raw["quote"] = quote
        raw["status"] = "open"
        raw["createdAt"] = ISO8601DateFormatter().string(from: Date())
        raw["createdBy"] = "iPhone"
        if let scope { raw["scope"] = scope }
        return Note(raw: raw)
    }
}

struct OutlineItem: Identifiable, Equatable {
    let id: String
    let level: Int
    let text: String
    let line: Int
}

/// 最近打开的文档:用安全作用域书签记住位置,文件改名/移动后仍能找回。
struct RecentDocument: Identifiable, Codable, Equatable {
    var id: String
    var name: String
    var bookmark: Data
    var lastOpenedAt: Date
    var directoryHint: String
}

enum Hashing {
    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    static func sha256(_ text: String) -> String { sha256(Data(text.utf8)) }
}

/// 同步传输层接口(跨端规则第 4、6 节):手机只提交批注批次、接收回执与新版快照。
/// 首版实现为"导出文件"(ExportTransport):批次写成文件由用户分享(AirDrop/隔空投送到 Mac)。
/// CloudKit 实现待开发者账户激活后接入,界面与存储层不需要改。
protocol SyncTransport {
    func submit(batch: AnnotationBatch) throws -> URL
}

struct AnnotationBatch: Codable {
    /// 有轮次身份(Mac 推来的文档)就是 version 2(逐条带身份);手机独立文件导出仍是 1
    var version: Int = 2
    var batchId: String
    var documentName: String
    var baseVersion: String   // 所依据的文档版本指纹(SHA-256)
    var completedAt: String
    var device: String
    var annotationsJSON: String  // 批注数组的 JSON 原文(保留全部字段)
    var docId: String? = nil     // Mac 推来的文档才有(跨端规则第 3 节:手机只认文档标识,不认路径)
    var reviewId: String? = nil

    func asJSONData() throws -> Data {
        var object: [String: Any] = [
            "version": (docId != nil && reviewId != nil) ? version : 1, "batchId": batchId, "documentName": documentName,
            "baseVersion": baseVersion, "completedAt": completedAt, "device": device,
        ]
        if let docId { object["docId"] = docId }
        if let reviewId { object["reviewId"] = reviewId }
        if let data = annotationsJSON.data(using: .utf8), let array = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            object["annotations"] = array
        } else {
            object["annotations"] = []
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    }
}

struct ExportTransport: SyncTransport {
    func submit(batch: AnnotationBatch) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("draftback-batches", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = batch.documentName.replacingOccurrences(of: ".md", with: "")
        let url = directory.appendingPathComponent("\(name).\(batch.batchId.prefix(8)).draftback-batch.json")
        try batch.asJSONData().write(to: url, options: .atomic)
        return url
    }
}
