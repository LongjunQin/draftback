import Foundation
import CloudKit
import UIKit

/// 云端约定(跨端规则第 12 节),与 Mac 端 mac-sync/Sources/CloudStore.swift 一字不差:
/// 私有数据库、自定义区 `draftback`;手机只读 ReviewDocument / Attachment / Receipt,只写 AnnotationBatch。
enum CloudSchema {
    static let containerID = "iCloud.app.draftback"
    static let zoneName = "draftback"
    static let reviewDocument = "ReviewDocument"
    static let attachment = "Attachment"
    static let annotationBatch = "AnnotationBatch"
    static let receipt = "Receipt"
    static let subscriptionID = "draftback-zone-changes"
}

/// Mac 推过来的一篇文档(手机上的元数据;正文与附件在 synced/<docId>/ 目录里)。
struct SyncedDocument: Identifiable, Codable, Equatable {
    var docId: String
    var reviewId: String
    var title: String
    var round: Int
    var status: String
    var applyMode: String
    var phoneState: String
    var contentHash: String
    var summary: String
    var openCount: Int
    var pushedAt: Date?
    var pusher: String
    var contentAvailable: Bool
    var updatedAt: Date
    /// 发布序号(跨端规则 v2.3 第 12 节):比本地记录小的发布一律忽略;旧缓存没有这个字段
    var revision: Int? = nil
    var outcome: String? = nil

    var id: String { docId }

    /// 跨端规则第 7 节的手机状态链(文档层面);批注层面的"等待同步 / Mac 已接收"由批注状态决定。
    var stateLabel: String {
        switch phoneState {
        case "reviewing": return "可批注"
        case "waiting-agent": return "等待智能体"
        case "applying": return "修改中"
        case "manual-editing": return "Mac 上正在手工修改"
        case "completed": return "稿子回来了"
        case "restored": return "已恢复到改稿前"
        case "finalized": return "已定稿"
        case "conflict": return "原文已变,等待 Mac 处理"
        case "cancelled": return "已取消"
        default: return status
        }
    }
    /// 状态上允许批注;正文字节是否真的是这一轮的,由 OpenedDocument.annotationAllowed 再核一次
    var canAnnotate: Bool { phoneState == "reviewing" }
}

/// Mac 对某个批次的回执。
struct SyncReceipt: Codable, Equatable {
    var batchId: String
    var docId: String
    var reviewId: String
    var accepted: Bool
    var reason: String
    var message: String
    var acceptedIds: [String]
    var receivedAt: Date?
    /// 批次原身份与指纹(v2.3 第 6.6 条):把拒收原因挂到正确的批注上
    var batchReviewId: String? = nil
    var baseVersion: String? = nil
    var latestRound: Int? = nil
}

/// 与 iCloud 打交道的全部逻辑:拉取文档与回执、提交批次(失败进待上传队列,联网后重试)、订阅静默推送。
@MainActor
final class CloudSyncEngine: ObservableObject {
    @Published private(set) var documents: [SyncedDocument] = []
    @Published private(set) var accountStatus: CKAccountStatus = .couldNotDetermine
    @Published private(set) var lastError: String?
    @Published private(set) var syncing = false
    @Published private(set) var lastPullAt: Date?
    @Published private(set) var pendingUploads = 0

    /// 收到回执时回调(DocumentStore 据此更新批注状态)
    var onReceipt: ((SyncReceipt) -> Void)?

    private let container = CKContainer(identifier: CloudSchema.containerID)
    private var database: CKDatabase { container.privateCloudDatabase }
    private let zoneID = CKRecordZone.ID(zoneName: CloudSchema.zoneName, ownerName: CKCurrentUserDefaultName)
    private let root: URL       // …/Draftback/synced
    private let stateDir: URL   // …/Draftback/sync
    private let fileManager = FileManager.default

    init(dataDirectory: URL) {
        root = dataDirectory.appendingPathComponent("synced", isDirectory: true)
        stateDir = dataDirectory.appendingPathComponent("sync", isDirectory: true)
        // 云端容器换了(改名):本地镜像、变更令牌、回执全部作废,重新从新容器拉;没上传的批次保留,会投到新容器
        let marker = stateDir.appendingPathComponent("container")
        let previous = (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        if previous != CloudSchema.containerID {
            try? fileManager.removeItem(at: root)
            try? fileManager.removeItem(at: stateDir.appendingPathComponent("zone-change-token"))
            try? fileManager.removeItem(at: stateDir.appendingPathComponent("receipts"))
            UserDefaults.standard.removeObject(forKey: "draftback.cloud.subscribed.v1")
            try? fileManager.createDirectory(at: stateDir, withIntermediateDirectories: true)
            try? CloudSchema.containerID.write(to: marker, atomically: true, encoding: .utf8)
        }
        for dir in [root, stateDir, stateDir.appendingPathComponent("outbox"), stateDir.appendingPathComponent("receipts")] {
            try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        documents = loadIndex()
        pendingUploads = outboxFiles().count
    }

    // MARK: 目录

    func directory(for docId: String) -> URL { root.appendingPathComponent(docId, isDirectory: true) }
    func contentURL(for docId: String) -> URL { directory(for: docId).appendingPathComponent("content.md") }
    func receipt(for batchId: String) -> SyncReceipt? {
        guard let data = try? Data(contentsOf: stateDir.appendingPathComponent("receipts/\(batchId).json")) else { return nil }
        return try? JSONDecoder().decode(SyncReceipt.self, from: data)
    }

    private var indexFile: URL { root.appendingPathComponent("index.json") }
    private func loadIndex() -> [SyncedDocument] {
        guard let data = try? Data(contentsOf: indexFile),
              let items = try? JSONDecoder().decode([SyncedDocument].self, from: data) else { return [] }
        return items.sorted { $0.updatedAt > $1.updatedAt }
    }
    private func saveIndex() {
        if let data = try? JSONEncoder().encode(documents) { try? data.write(to: indexFile, options: .atomic) }
    }

    // MARK: 刷新(启动、回到前台、收到静默推送时调用)

    func refresh() async {
        if syncing { return }
        syncing = true
        defer { syncing = false }
        do {
            accountStatus = try await container.accountStatus()
            guard accountStatus == .available else {
                lastError = "未登录 iCloud,收不到 Mac 推来的文档。请在系统设置里登录与 Mac 相同的 Apple ID。"
                return
            }
            await subscribeIfNeeded()
            await retryOutbox()
            try await pull()
            lastError = nil
            lastPullAt = Date()
        } catch let error as CKError where error.code == .zoneNotFound || error.code == .userDeletedZone {
            // Mac 还没推过任何东西(区尚未创建):不算错
            lastError = nil
            lastPullAt = Date()
        } catch {
            lastError = "同步失败:\(error.localizedDescription)"
        }
    }

    // MARK: 拉取:ReviewDocument / Attachment / Receipt

    private var tokenFile: URL { stateDir.appendingPathComponent("zone-change-token") }
    private func loadToken() -> CKServerChangeToken? {
        guard let data = try? Data(contentsOf: tokenFile) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: data)
    }
    private func saveToken(_ token: CKServerChangeToken) {
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) {
            try? data.write(to: tokenFile, options: .atomic)
        }
    }

    func pull() async throws {
        var cursor = loadToken()
        var moreComing = true
        var touched = false
        while moreComing {
            let page: (modificationResultsByID: [CKRecord.ID: Result<CKDatabase.RecordZoneChange.Modification, Error>],
                       deletions: [CKDatabase.RecordZoneChange.Deletion], changeToken: CKServerChangeToken, moreComing: Bool)
            do {
                page = try await database.recordZoneChanges(inZoneWith: zoneID, since: cursor)
            } catch let error as CKError where error.code == .changeTokenExpired {
                try? fileManager.removeItem(at: tokenFile)
                cursor = nil
                continue
            }
            for (_, result) in page.modificationResultsByID {
                guard case .success(let modification) = result else { continue }
                if apply(record: modification.record) { touched = true }
            }
            for deletion in page.deletions where deletion.recordType == CloudSchema.reviewDocument {
                remove(docId: deletion.recordID.recordName)
                touched = true
            }
            saveToken(page.changeToken)
            cursor = page.changeToken
            moreComing = page.moreComing
        }
        if touched { saveIndex() }
    }

    /// 返回是否改动了本地状态
    private func apply(record: CKRecord) -> Bool {
        switch record.recordType {
        case CloudSchema.reviewDocument: return applyDocument(record)
        case CloudSchema.attachment: return applyAttachment(record)
        case CloudSchema.receipt: return applyReceipt(record)
        default: return false
        }
    }

    private func applyDocument(_ record: CKRecord) -> Bool {
        let docId = record.recordID.recordName
        let dir = directory(for: docId)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        let contentHash = record["contentHash"] as? String ?? ""
        let revision = (record["revision"] as? Int64).map(Int.init)
        // 发布先后:比本地已有记录旧的发布一律忽略(迟到的旧发布不能覆盖新状态)
        if let revision, let prior = documents.first(where: { $0.docId == docId }), let priorRevision = prior.revision, revision < priorRevision {
            return false
        }
        var available = (record["contentAvailable"] as? Int64 ?? 0) == 1
        let target = contentURL(for: docId)
        if available, let asset = record["content"] as? CKAsset, let source = asset.fileURL {
            let existing = (try? Data(contentsOf: target)).map { Hashing.sha256($0) }
            if existing != contentHash {
                try? fileManager.removeItem(at: target)
                try? fileManager.copyItem(at: source, to: target)
            }
            // 复制后校验字节:对不上就当正文不可用(旧缓存照旧按旧身份只读显示)
            let copied = (try? Data(contentsOf: target)).map { Hashing.sha256($0) }
            if copied != contentHash { available = false }
        } else {
            // 只推状态(作废 / 非 UTF-8 / 发布失败):本地旧正文仍在,但它不是这一轮的;只有指纹相同才算可用
            let existing = (try? Data(contentsOf: target)).map { Hashing.sha256($0) }
            available = existing == contentHash
        }
        let item = SyncedDocument(
            docId: docId,
            reviewId: record["reviewId"] as? String ?? "",
            title: record["title"] as? String ?? "未命名.md",
            round: Int(record["round"] as? Int64 ?? 1),
            status: record["status"] as? String ?? "",
            applyMode: record["applyMode"] as? String ?? "",
            phoneState: record["phoneState"] as? String ?? "",
            contentHash: contentHash,
            summary: record["summary"] as? String ?? "",
            openCount: Int(record["openCount"] as? Int64 ?? 0),
            pushedAt: record["pushedAt"] as? Date,
            pusher: record["pusher"] as? String ?? "Mac",
            contentAvailable: available,
            updatedAt: Date(),
            revision: revision,
            outcome: record["outcome"] as? String
        )
        documents.removeAll { $0.docId == docId }
        documents.insert(item, at: 0)
        return true
    }

    private func applyAttachment(_ record: CKRecord) -> Bool {
        guard let docId = record["docId"] as? String, let relPath = record["relPath"] as? String,
              let asset = record["data"] as? CKAsset, let source = asset.fileURL else { return false }
        // 相对路径只能落在文档目录里:拒绝绝对路径与 ..
        let parts = relPath.split(separator: "/").map(String.init)
        guard !relPath.hasPrefix("/"), !parts.contains(".."), !parts.isEmpty else { return false }
        let target = directory(for: docId).appendingPathComponent(relPath)
        try? fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        let sha = record["sha256"] as? String ?? ""
        if let data = try? Data(contentsOf: target), Hashing.sha256(data) == sha { return false }
        try? fileManager.removeItem(at: target)
        try? fileManager.copyItem(at: source, to: target)
        return true
    }

    private func applyReceipt(_ record: CKRecord) -> Bool {
        guard let batchId = record["batchId"] as? String else { return false }
        var ids: [String] = []
        if let json = record["acceptedIds"] as? String, let data = json.data(using: .utf8),
           let list = try? JSONSerialization.jsonObject(with: data) as? [String] { ids = list }
        let receipt = SyncReceipt(batchId: batchId, docId: record["docId"] as? String ?? "", reviewId: record["reviewId"] as? String ?? "",
                                  accepted: (record["accepted"] as? Int64 ?? 0) == 1, reason: record["reason"] as? String ?? "",
                                  message: record["message"] as? String ?? "", acceptedIds: ids, receivedAt: record["receivedAt"] as? Date,
                                  batchReviewId: record["batchReviewId"] as? String, baseVersion: record["baseVersion"] as? String,
                                  latestRound: (record["latestRound"] as? Int64).map(Int.init))
        if let data = try? JSONEncoder().encode(receipt) {
            try? data.write(to: stateDir.appendingPathComponent("receipts/\(batchId).json"), options: .atomic)
        }
        // 收到回执说明这批已经送达,待上传队列里的副本可以删了
        try? fileManager.removeItem(at: stateDir.appendingPathComponent("outbox/\(batchId).json"))
        pendingUploads = outboxFiles().count
        onReceipt?(receipt)
        return false
    }

    private func remove(docId: String) {
        documents.removeAll { $0.docId == docId }
        try? fileManager.removeItem(at: directory(for: docId))
    }

    // MARK: 提交批次:AnnotationBatch(失败进待上传队列)

    /// 返回 true 表示已上传;false 表示暂存在待上传队列,联网后自动重试
    func submit(batch: AnnotationBatch) async -> Bool {
        guard let data = try? batch.asJSONData() else { return false }
        let queued = stateDir.appendingPathComponent("outbox/\(batch.batchId).json")
        try? data.write(to: queued, options: .atomic)
        pendingUploads = outboxFiles().count
        let uploaded = await upload(batchData: data)
        if uploaded {
            try? fileManager.removeItem(at: queued)
            pendingUploads = outboxFiles().count
        }
        return uploaded
    }

    private func outboxFiles() -> [URL] {
        (try? fileManager.contentsOfDirectory(at: stateDir.appendingPathComponent("outbox"), includingPropertiesForKeys: nil)) ?? []
    }

    func retryOutbox() async {
        for file in outboxFiles() {
            guard let data = try? Data(contentsOf: file) else { continue }
            if await upload(batchData: data) { try? fileManager.removeItem(at: file) }
        }
        pendingUploads = outboxFiles().count
    }

    private func upload(batchData: Data) async -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: batchData) as? [String: Any],
              let batchId = object["batchId"] as? String else { return false }
        let record = CKRecord(recordType: CloudSchema.annotationBatch, recordID: CKRecord.ID(recordName: batchId, zoneID: zoneID))
        record["version"] = Int64((object["version"] as? Int) ?? 1) // 真实写出协议版本,Mac 桥层原样传递
        record["batchId"] = batchId
        record["docId"] = object["docId"] as? String ?? ""
        record["reviewId"] = object["reviewId"] as? String ?? ""
        record["documentName"] = object["documentName"] as? String ?? ""
        record["baseVersion"] = object["baseVersion"] as? String ?? ""
        record["completedAt"] = object["completedAt"] as? String ?? ""
        record["device"] = object["device"] as? String ?? UIDevice.current.name
        if let annotations = object["annotations"], let json = try? JSONSerialization.data(withJSONObject: annotations) {
            record["annotations"] = String(decoding: json, as: UTF8.self)
        } else {
            record["annotations"] = "[]"
        }
        do {
            _ = try await database.modifyRecords(saving: [record], deleting: [], savePolicy: .allKeys, atomically: true)
            return true
        } catch let error as CKError where error.code == .serverRecordChanged {
            return true // 同一批次已经在云端(重发):按已上传处理,Mac 按批次编号去重
        } catch let error as CKError where error.code == .zoneNotFound {
            // Mac 还没建区:自己建一个,下一次重试就能上传
            _ = try? await database.modifyRecordZones(saving: [CKRecordZone(zoneID: zoneID)], deleting: [])
            lastError = "正在建立同步区,稍后自动重试。"
            return false
        } catch {
            lastError = "批注上传失败,已存入待上传队列:\(error.localizedDescription)"
            return false
        }
    }

    // MARK: 静默推送订阅

    private var subscribedKey: String { "draftback.cloud.subscribed.v1" }
    private var subscriptionVerified = false
    private func subscribeIfNeeded() async {
        if UserDefaults.standard.bool(forKey: subscribedKey) {
            // 标记只说明以前订阅过;容器的开发环境被初始化或重置后云端订阅会消失,所以每次启动核对一次,没有就重订
            if subscriptionVerified { return }
            if (try? await database.subscription(for: CloudSchema.subscriptionID)) != nil {
                subscriptionVerified = true
                return
            }
        }
        let subscription = CKDatabaseSubscription(subscriptionID: CloudSchema.subscriptionID)
        let info = CKSubscription.NotificationInfo()
        info.shouldSendContentAvailable = true
        subscription.notificationInfo = info
        do {
            _ = try await database.modifySubscriptions(saving: [subscription], deleting: [])
            UserDefaults.standard.set(true, forKey: subscribedKey)
            subscriptionVerified = true
        } catch {
            // 没订阅成功也不影响使用:回到前台时照样拉取
        }
    }

    static func isCloudKitPush(_ userInfo: [AnyHashable: Any]) -> Bool {
        CKNotification(fromRemoteNotificationDictionary: userInfo) != nil
    }
}
