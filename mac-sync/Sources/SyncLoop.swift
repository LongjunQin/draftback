import Foundation
import Security
import CloudKit

/// 主循环:每 15 秒一轮——账号心跳 → 推待推送项 → 拉手机批次并回执。任何一步失败只记日志,下一轮再来。
final class SyncLoop {
    let server: ServerClient
    let cloud: CloudStore
    let log: Logger
    let parentPid: Int32?
    let interval: TimeInterval
    private let tempDir: URL
    private let containerMarker: URL
    private var consecutiveFailures = 0

    init(dataDir: URL, parentPid: Int32?, interval: TimeInterval, log: Logger) {
        let stateDir = dataDir.appendingPathComponent("sync", isDirectory: true)
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        server = ServerClient(dataDir: dataDir)
        cloud = CloudStore(stateDir: stateDir)
        containerMarker = stateDir.appendingPathComponent("container")
        self.parentPid = parentPid
        self.interval = interval
        self.log = log
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("draftback-sync-\(getpid())", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    func run() async -> Never {
        log.info("Draftback Sync 启动,数据目录 \(server.dataDir.path),容器 \(CloudSchema.containerID)")
        while true {
            if let pid = parentPid, kill(pid, 0) != 0, errno == ESRCH {
                log.info("主进程已退出,随之退出")
                exit(0)
            }
            let didWork = await tick()
            try? await Task.sleep(nanoseconds: UInt64((didWork ? 3 : interval) * 1_000_000_000))
        }
    }

    /// 一轮;返回是否做了实际工作(做了就缩短下一轮的等待,把一批文档尽快推完)
    /// 云端容器换了(改名 iCloud.org.mdturn → iCloud.app.draftback):旧容器里的记录全部作废,
    /// 清掉变更令牌,并让本地服务把所有参与同步的文档重新推一遍。只做一次,以数据目录里的标记为准。
    private func ensureContainerGeneration() async throws {
        let previous = try? String(contentsOf: containerMarker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        if previous == CloudSchema.containerID { return }
        cloud.clearToken()
        let result = try await server.resetPushes()
        try CloudSchema.containerID.write(to: containerMarker, atomically: true, encoding: .utf8)
        log.info("云端容器切换为 \(CloudSchema.containerID)(之前: \(previous ?? "无")),已重排 \(result["count"] ?? 0) 篇文档待推送")
    }

    /// 排查用:删除云端记录(--delete-records)
    func deleteRecords(_ names: [String]) async throws {
        try await cloud.ensureZone()
        try await cloud.delete(names)
    }

    func tick() async -> Bool {
        var worked = false
        var heartbeat: [String: Any] = ["version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"]
        do {
            let status = try await cloud.accountStatus()
            heartbeat["accountStatus"] = describe(status)
            heartbeat["environment"] = environmentName()
            guard status == .available else {
                heartbeat["error"] = "iCloud 账号不可用(\(describe(status))),请在系统设置里登录 iCloud"
                try? await server.heartbeat(heartbeat)
                return false
            }
            try await ensureContainerGeneration()
            try await cloud.ensureZone()
            worked = try await pushOutbox() || worked
            worked = try await pullBatches() || worked
            consecutiveFailures = 0
        } catch {
            consecutiveFailures += 1
            let message = Describe.error(error)
            heartbeat["error"] = message
            if consecutiveFailures == 1 || consecutiveFailures % 20 == 0 { log.error("本轮失败(\(consecutiveFailures) 次): \(message)") }
        }
        try? await server.heartbeat(heartbeat)
        return worked
    }

    // MARK: 推:Mac → 云

    /// 返回是否真的推成功了至少一篇:全失败时按正常间隔重试,不缩短等待(否则会 3 秒一次地撞服务器);
    /// 同一篇文档同样的错误只写一次日志(服务端把上次的错误带在队列条目里)
    func pushOutbox() async throws -> Bool {
        let items = try await server.outbox()
        guard !items.isEmpty else { return false }
        var pushed = 0
        for item in items {
            guard let reviewId = item["reviewId"] as? String, let docId = item["docId"] as? String else { continue }
            do {
                let payload = try await server.pushPayload(reviewId: reviewId)
                try await pushDocument(docId: docId, reviewId: reviewId, payload: payload)
                try await server.markPushed(reviewId: reviewId,
                                            signature: payload["signature"] as? String ?? "",
                                            contentHash: payload["contentHash"] as? String ?? "")
                log.info("已推送 \(item["title"] as? String ?? docId) 第 \(item["round"] ?? 1) 轮(\(item["phoneState"] ?? "?"))")
                pushed += 1
            } catch {
                let message = Describe.error(error)
                // 服务端错误里带请求编号和时间,逐字比较永远不同;只看开头(错误码与类别)是否一样
                if (item["lastError"] as? String)?.prefix(60) != message.prefix(60) {
                    log.error("推送 \(item["title"] as? String ?? docId) 失败: \(message)")
                }
                try? await server.markPushError(reviewId: reviewId, error: message)
            }
        }
        return pushed > 0
    }

    private func pushDocument(docId: String, reviewId: String, payload: [String: Any]) async throws {
        let existing = try await cloud.fetch([docId])[docId]
        let record = existing ?? CKRecord(recordType: CloudSchema.reviewDocument, recordID: cloud.recordID(docId))
        record["docId"] = docId
        record["reviewId"] = reviewId
        record["title"] = payload["title"] as? String ?? ""
        record["round"] = Int64((payload["round"] as? Int) ?? 1)
        record["status"] = payload["status"] as? String ?? ""
        record["applyMode"] = payload["applyMode"] as? String ?? ""
        record["phoneState"] = payload["phoneState"] as? String ?? ""
        record["contentHash"] = payload["contentHash"] as? String ?? ""
        record["summary"] = payload["summary"] as? String ?? ""
        record["openCount"] = Int64((payload["openCount"] as? Int) ?? 0)
        record["pushedAt"] = Date()
        record["pusher"] = Host.current().localizedName ?? "Mac"

        var records: [CKRecord] = []
        if let content = payload["content"] as? String {
            // 正文走 CKAsset(没有 1 MB 的字段上限);附件按清单逐个上传,校验码没变的跳过
            let contentFile = tempDir.appendingPathComponent("\(docId)-\(UUID().uuidString).md")
            try content.write(to: contentFile, atomically: true, encoding: .utf8)
            record["content"] = CKAsset(fileURL: contentFile)
            record["contentAvailable"] = Int64(1)

            let manifest = (payload["attachments"] as? [[String: Any]]) ?? []
            var listed: [[String: Any]] = []
            let names = manifest.compactMap { entry -> String? in
                guard let rel = entry["relPath"] as? String else { return nil }
                return CloudSchema.attachmentName(docId: docId, relPath: rel)
            }
            let existingAttachments = try await cloud.fetch(names)
            for entry in manifest {
                guard let rel = entry["relPath"] as? String else { continue }
                let name = CloudSchema.attachmentName(docId: docId, relPath: rel)
                let sha = entry["sha256"] as? String ?? ""
                let included = (entry["included"] as? Bool) ?? false
                listed.append(["relPath": rel, "recordName": name, "sha256": sha, "bytes": entry["bytes"] ?? 0,
                               "included": included, "reason": entry["reason"] ?? NSNull()])
                guard included else { continue }
                if let prior = existingAttachments[name], (prior["sha256"] as? String) == sha { continue }
                let data = try await server.attachment(reviewId: reviewId, relPath: rel)
                let file = tempDir.appendingPathComponent("\(name)-\(UUID().uuidString)")
                try data.write(to: file, options: .atomic)
                let attachment = existingAttachments[name] ?? CKRecord(recordType: CloudSchema.attachment, recordID: cloud.recordID(name))
                attachment["docId"] = docId
                attachment["relPath"] = rel
                attachment["bytes"] = Int64(data.count)
                attachment["sha256"] = sha
                attachment["data"] = CKAsset(fileURL: file)
                records.append(attachment)
            }
            let manifestData = try JSONSerialization.data(withJSONObject: listed)
            record["attachments"] = String(decoding: manifestData, as: UTF8.self)
        } else {
            record["contentAvailable"] = Int64(0)
        }
        records.append(record)
        try await cloud.save(records)
        try? FileManager.default.removeItem(at: tempDir)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    // MARK: 拉:云 → Mac(手机提交的批次)

    func pullBatches() async throws -> Bool {
        let changes = try await cloud.fetchChanges(since: cloud.loadToken())
        let batches = changes.changed.filter { $0.recordType == CloudSchema.annotationBatch }
        var worked = false
        for record in batches {
            try await handleBatch(record)
            worked = true
        }
        // 全部处理成功才推进令牌;中途失败则下一轮从同一位置重拉(服务端按批次编号去重,不会重复写入)
        if let token = changes.token { try cloud.saveToken(token) }
        return worked
    }

    private func handleBatch(_ record: CKRecord) async throws {
        guard let batchId = record["batchId"] as? String ?? Optional(record.recordID.recordName) else { return }
        // 云端已有这个批次的回执(这台或别的 Mac 早处理过;换电脑、重装、令牌丢失后会重拉历史):绝不重做,否则会把"已采用"覆盖成"拒收"
        let receiptName = CloudSchema.receiptName(batchId: batchId)
        if try await cloud.fetch([receiptName])[receiptName] != nil {
            log.info("手机批次 \(batchId.prefix(8)) 已有回执,跳过")
            return
        }
        var batch: [String: Any] = [
            "version": 1,
            "batchId": batchId,
            "docId": record["docId"] as? String ?? "",
            "reviewId": record["reviewId"] as? String ?? "",
            "documentName": record["documentName"] as? String ?? "",
            "baseVersion": record["baseVersion"] as? String ?? "",
            "completedAt": record["completedAt"] as? String ?? ISO8601DateFormatter().string(from: Date()),
            "device": record["device"] as? String ?? "iPhone",
        ]
        if let json = record["annotations"] as? String, let data = json.data(using: .utf8),
           let array = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            batch["annotations"] = array
        } else {
            batch["annotations"] = []
        }
        let result = try await server.importBatch(batch)
        let receipt = (result["receipt"] as? [String: Any]) ?? [:]
        let reviewId = ((result["review"] as? [String: Any])?["id"] as? String) ?? (batch["reviewId"] as? String) ?? ""
        if (receipt["reused"] as? Bool) == true, record["receiptWrittenAt"] != nil { return }
        // 这台 Mac 从没见过这个文档(别的电脑发起的审阅):不是我们的批次,不回执、不打扰手机
        if (receipt["reason"] as? String) == "no-session", (result["documentKnown"] as? Bool) != true {
            log.info("手机批次 \(batchId.prefix(8)) 不属于这台 Mac 的文档,跳过")
            return
        }

        let receiptRecord = CKRecord(recordType: CloudSchema.receipt, recordID: cloud.recordID(receiptName))
        receiptRecord["batchId"] = batchId
        receiptRecord["docId"] = batch["docId"] as? String ?? ""
        receiptRecord["reviewId"] = reviewId
        receiptRecord["accepted"] = Int64((receipt["accepted"] as? Bool) == true ? 1 : 0)
        receiptRecord["reason"] = receipt["reason"] as? String ?? ""
        receiptRecord["message"] = receipt["message"] as? String ?? ""
        let acceptedIds = (receipt["acceptedIds"] as? [String]) ?? []
        receiptRecord["acceptedIds"] = String(decoding: try JSONSerialization.data(withJSONObject: acceptedIds), as: UTF8.self)
        receiptRecord["receivedAt"] = Date()
        try await cloud.save([receiptRecord])
        if !reviewId.isEmpty { try? await server.markReceiptSent(reviewId: reviewId, batchId: batchId) }
        let verdict = (receipt["accepted"] as? Bool) == true ? "已采用 \(acceptedIds.count) 条" : "拒收(\(receipt["reason"] ?? "?"))"
        log.info("收到手机批次 \(batchId.prefix(8)) → \(verdict)")
    }

    // MARK: 杂项

    private func describe(_ status: CKAccountStatus) -> String {
        switch status {
        case .available: return "available"
        case .noAccount: return "noAccount"
        case .restricted: return "restricted"
        case .couldNotDetermine: return "couldNotDetermine"
        case .temporarilyUnavailable: return "temporarilyUnavailable"
        @unknown default: return "unknown"
        }
    }

    private func environmentName() -> String {
        // 以自己签名里的 icloud-container-environment 为准(Debug 构建写 Development,Release 写 Production);没有这条时系统默认走 Production
        guard let task = SecTaskCreateFromSelf(nil),
              let value = SecTaskCopyValueForEntitlement(task, "com.apple.developer.icloud-container-environment" as CFString, nil) else { return "production" }
        if let text = value as? String { return text.lowercased() }
        if let list = value as? [String], let first = list.first { return first.lowercased() }
        return "unknown"
    }
}

/// 日志写到数据目录 sync-helper.log,超过 1 MB 从头来;没有界面,这是唯一能看见它在干什么的地方
final class Logger {
    private let file: URL
    private let formatter = ISO8601DateFormatter()
    init(dataDir: URL) { file = dataDir.appendingPathComponent("sync-helper.log") }
    func info(_ message: String) { write("INFO", message) }
    func error(_ message: String) { write("ERROR", message) }
    private func write(_ level: String, _ message: String) {
        let line = "\(formatter.string(from: Date())) \(level) \(message)\n"
        if let size = try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int, size > 1_048_576 {
            try? FileManager.default.removeItem(at: file)
        }
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close()
        } else {
            try? line.write(to: file, atomically: true, encoding: .utf8)
        }
        FileHandle.standardError.write(Data(line.utf8))
    }
}

/// 把 CKError 连同服务端给的细节(ServerErrorDescription、分项失败)一起打出来,否则只有一句「Server Rejected Request」没法排查
enum Describe {
    static func error(_ error: Error) -> String {
        guard let ck = error as? CKError else { return "\(error)" }
        var parts = ["\(ck.code)(\(ck.code.rawValue))"]
        if let server = ck.userInfo["ServerErrorDescription"] as? String { parts.append("服务端: \(server)") }
        if let desc = ck.userInfo[NSLocalizedDescriptionKey] as? String { parts.append(desc) }
        if let partial = ck.partialErrorsByItemID {
            for (id, sub) in partial.prefix(5) { parts.append("[\(id)] \(Describe.error(sub))") }
        }
        if let retry = ck.retryAfterSeconds { parts.append("retryAfter=\(retry)") }
        if let underlying = ck.userInfo[NSUnderlyingErrorKey] as? NSError { parts.append("underlying: \(underlying.domain) \(underlying.code) \(underlying.userInfo)") }
        return parts.joined(separator: " | ")
    }
}
