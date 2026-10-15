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
    /// 已交出的三档(电脑版规划 v3 规则②):none 还没有 AI 接入 / listening AI 在线,等待领取 / claimed AI 正在修改;其他状态为空
    var agentState: String? = nil
    /// 稿子回来时的逐条结果与计数(v2.4);别的状态为空
    var results: RoundResults? = nil
    /// 这台 Mac 能收的批次协议(v2.4):≥ 3 才给「稿子回来后接着批」和「定稿」;旧 Mac 没有这个字段
    var macProtocol: Int? = nil
    /// 云端记录已被删(Mac 的云端清理:定稿或作废满 30 天):手机上的副本留着,只读,用户自己从列表移除
    var cloudRemoved: Bool? = nil
    /// 终态(稿子回来、通过、恢复、定稿、作废):Mac 支持时,手机上划词就开始下一轮
    var isTerminal: Bool { ["completed", "restored", "finalized", "cancelled"].contains(phoneState) }
    var supportsIntents: Bool { (macProtocol ?? 0) >= 3 }

    /// 「AI 在线,等待领取」要有期限:Mac 在 AI 监听期间每 10 分钟重推一次;超过 20 分钟没刷新(Mac 关机、断网),
    /// 手机不再说 AI 在线,只说已交出(跨端规则第 7 节:过期监听不得继续显示为在线)
    func effectiveAgentState(now: Date = Date()) -> String? {
        guard agentState == "listening" else { return agentState }
        guard let pushedAt, now.timeIntervalSince(pushedAt) <= 20 * 60 else { return nil }
        return agentState
    }

    var id: String { docId }
    /// 状态上允许批注;正文字节是否真的是这一轮的,由 OpenedDocument.annotationAllowed 再核一次
    var canAnnotate: Bool { phoneState == "reviewing" }
}

/// 稿子回来时本轮的处理结果(跨端规则 v2.4 第 5 节):与 Mac 回稿卡同一套说法
struct RoundResults: Codable, Equatable {
    struct Item: Codable, Equatable, Identifiable {
        var id: String
        var scope: String     // text / document
        var quote: String
        var you: String       // 你说了什么
        var ai: String        // AI 怎么处理(含「未采纳:理由」)
        var status: String    // applied / wontfix / cancelled / open
    }
    var applied: Int
    var wontfix: Int
    var total: Int
    var actor: String?
    var items: [Item]
    /// 列表按字节预算放,放不下的没带过来(计数仍是全部)
    var truncated: Bool? = nil
}

/// 手机换新版前留下的上一版正文(回稿卡「显示改动」在本机对比用)。
/// reviewId 与现在这一版相同 = 同一轮的原稿与完成稿;不同 = 手机错过了中间几版,只能和手机上的上一版比。
struct PreviousVersion: Codable, Equatable {
    var hash: String
    var reviewId: String
    var round: Int
    var savedAt: Date
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
    /// v2.4:执行的意图与目标轮(next-round 新开的一轮)
    var intent: String? = nil
    var targetReviewId: String? = nil
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
    /// 换了 iCloud 账号、本地镜像换成那个账号的之后回调(正开着的旧账号稿件要关掉)
    var onAccountSwitched: (() -> Void)?

    private let container = CKContainer(identifier: CloudSchema.containerID)
    private var database: CKDatabase { container.privateCloudDatabase }
    private let zoneID = CKRecordZone.ID(zoneName: CloudSchema.zoneName, ownerName: CKCurrentUserDefaultName)
    private let dataDirectory: URL
    private let fileManager = FileManager.default
    /// 跨端规则第 9 节:每个 iCloud 账号一个目录 accounts/<账号指纹>/,里面是这个账号的稿件镜像(synced/)、同步状态(sync/:
    /// 变更令牌、待上传批次、回执)、这些稿件的批注(annotations/)与定稿请求(finalize.json)。换账号只换指针(sync-account),
    /// 不搬目录;中途退出也不丢。还不知道账号(升级上来第一次、从没联网)时用老位置,也就是数据目录本身
    private(set) var accountBase: URL
    private var root: URL { accountBase.appendingPathComponent("synced", isDirectory: true) }
    private var stateDir: URL { accountBase.appendingPathComponent("sync", isDirectory: true) }
    private var accountKey: String?
    private var accountMarker: URL { dataDirectory.appendingPathComponent("sync-account") }
    /// 账号代次:系统通知账号变了就加一;正在跑的同步每次上传、应用下载前都核对,变了就停(旧账号的东西不进新账号)
    private var accountGeneration = 0
    private var refreshAgain = false

    init(dataDirectory: URL) {
        self.dataDirectory = dataDirectory
        let marker = (try? String(contentsOf: dataDirectory.appendingPathComponent("sync-account"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        accountBase = marker.flatMap { $0.isEmpty ? nil : dataDirectory.appendingPathComponent("accounts/\($0)", isDirectory: true) } ?? dataDirectory
        prepareBase()
        documents = loadIndex()
        pendingUploads = outboxFiles().count
        NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.accountGeneration += 1
                self.accountKey = nil
                if self.syncing { self.refreshAgain = true } else { await self.refresh() }
            }
        }
    }

    /// 当前账号目录的准备:云端容器换了(改名)就把这个目录里的镜像、变更令牌、回执作废,重新从新容器拉;没上传的批次保留
    private func prepareBase() {
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
    }

    #if DEBUG
    /// 仅调试版:模拟器截图用的演示稿件(--demo-drafts)。不连 iCloud,只写本机镜像目录。
    private(set) var demoMode = false
    func seedDemo(_ items: [(doc: SyncedDocument, markdown: String)], previous: [String: String] = [:]) {
        demoMode = true
        for item in items {
            let dir = directory(for: item.doc.docId)
            try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
            try? item.markdown.write(to: contentURL(for: item.doc.docId), atomically: true, encoding: .utf8)
            try? fileManager.removeItem(at: previousInfoURL(for: item.doc.docId))
            if let old = previous[item.doc.docId] {
                recordContentIdentity(docId: item.doc.docId, hash: Hashing.sha256(old), reviewId: item.doc.reviewId, round: item.doc.round)
                keepPrevious(docId: item.doc.docId, data: Data(old.utf8), hash: Hashing.sha256(old))
            }
            recordContentIdentity(docId: item.doc.docId, hash: Hashing.sha256(item.markdown), reviewId: item.doc.reviewId, round: item.doc.round)
        }
        documents = items.map(\.doc)
        saveIndex()
        accountStatus = .available
        lastError = nil
        lastPullAt = Date().addingTimeInterval(-40)
    }
    #endif

    // MARK: 目录

    func directory(for docId: String) -> URL { root.appendingPathComponent(docId, isDirectory: true) }
    func contentURL(for docId: String) -> URL { directory(for: docId).appendingPathComponent("content.md") }
    func previousURL(for docId: String) -> URL { directory(for: docId).appendingPathComponent("previous.md") }
    /// content.md 实际是哪一轮的正文(写正文时一起记);只收到状态时不改它(跨端规则第 5 节:缓存绑定自己的身份)
    private func contentInfoURL(for docId: String) -> URL { directory(for: docId).appendingPathComponent("content.json") }
    private func contentIdentity(for docId: String) -> PreviousVersion? {
        guard let data = try? Data(contentsOf: contentInfoURL(for: docId)) else { return nil }
        return try? JSONDecoder().decode(PreviousVersion.self, from: data)
    }
    private func recordContentIdentity(docId: String, hash: String, reviewId: String, round: Int) {
        let info = PreviousVersion(hash: hash, reviewId: reviewId, round: round, savedAt: Date())
        if let data = try? JSONEncoder().encode(info) { try? data.write(to: contentInfoURL(for: docId), options: .atomic) }
    }
    private func previousInfoURL(for docId: String) -> URL { directory(for: docId).appendingPathComponent("previous.json") }
    func previousVersion(for docId: String) -> PreviousVersion? {
        guard let data = try? Data(contentsOf: previousInfoURL(for: docId)) else { return nil }
        return try? JSONDecoder().decode(PreviousVersion.self, from: data)
    }
    /// 换新版前把旧正文留一份;只留最近一版。身份取旧正文自己记下的(content.json),
    /// 不拿最新一条状态冒充——手机可能错过了中间几版;旧缓存没有记录时身份算未知
    private func keepPrevious(docId: String, data: Data, hash: String) {
        let known = contentIdentity(for: docId).flatMap { $0.hash == hash ? $0 : nil }
        let info = PreviousVersion(hash: hash, reviewId: known?.reviewId ?? "", round: known?.round ?? 0, savedAt: Date())
        guard let json = try? JSONEncoder().encode(info) else { return }
        do {
            try data.write(to: previousURL(for: docId), options: .atomic)
            try json.write(to: previousInfoURL(for: docId), options: .atomic)
        } catch {
            try? fileManager.removeItem(at: previousInfoURL(for: docId))
        }
    }
    /// 回执落盘后、批注改完前 App 被杀:启动时把还没标「已应用」的回执再应用一遍(应用本身幂等)
    private func receiptAppliedURL(_ batchId: String) -> URL { stateDir.appendingPathComponent("receipts/\(batchId).applied") }
    @discardableResult
    func markReceiptApplied(_ batchId: String) -> Bool {
        do { try Data().write(to: receiptAppliedURL(batchId), options: .atomic); return true } catch { return false }
    }
    func unappliedReceipts() -> [SyncReceipt] {
        let dir = stateDir.appendingPathComponent("receipts")
        let names = (try? fileManager.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.compactMap { name -> SyncReceipt? in
            let batchId = String(name.dropLast(5))
            guard !fileManager.fileExists(atPath: receiptAppliedURL(batchId).path) else { return nil }
            return receipt(for: batchId)
        }
    }

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

    /// 核对当前账号,切到它的目录。查不到(离线)、或查的时候账号又变了,就抛错:这一轮不上传、不拉取,免得投进别的账号
    private func ensureAccount() async throws {
        if accountKey != nil { return }
        let generation = accountGeneration
        let key = String(Hashing.sha256(try await container.userRecordID().recordName).prefix(16))
        guard generation == accountGeneration else { throw CancellationError() }
        try useAccount(key)
        accountKey = key
    }

    enum AccountError: LocalizedError {
        case adoptFailed(String)
        var errorDescription: String? {
            if case .adoptFailed(let what) = self { return "整理本机的同步数据没成功(\(what)),这一轮先不同步,稍后自动再试。" }
            return nil
        }
    }

    /// 切到某个账号的目录。第一次知道账号(还没有指针)时,先把老位置的数据搬进这个账号的目录:
    /// 稿件镜像、同步状态、这些稿件的批注、定稿请求。只搬一次;目标已有就不动,绝不删;有一样搬不动就停下(不写指针,下次再来)
    func useAccount(_ key: String) throws {
        let target = dataDirectory.appendingPathComponent("accounts/\(key)", isDirectory: true)
        let previous = (try? String(contentsOf: accountMarker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        if previous == key && accountBase == target { return }
        if previous == nil || previous?.isEmpty == true { try adoptLegacy(into: target) }
        try? fileManager.createDirectory(at: target, withIntermediateDirectories: true)
        try key.write(to: accountMarker, atomically: true, encoding: .utf8)
        accountBase = target
        prepareBase()
        UserDefaults.standard.removeObject(forKey: subscribedKey) // 订阅跟着账号走:换了账号要重新核对、订阅
        subscriptionVerified = false
        documents = loadIndex()
        pendingUploads = outboxFiles().count
        lastError = nil
        onAccountSwitched?()
    }

    private func adoptLegacy(into target: URL) throws {
        try? fileManager.createDirectory(at: target.appendingPathComponent("annotations", isDirectory: true), withIntermediateDirectories: true)
        let legacyDocIds = documents.map(\.docId)
        var moves: [(URL, URL)] = [
            (dataDirectory.appendingPathComponent("synced", isDirectory: true), target.appendingPathComponent("synced", isDirectory: true)),
            (dataDirectory.appendingPathComponent("sync", isDirectory: true), target.appendingPathComponent("sync", isDirectory: true)),
            (dataDirectory.appendingPathComponent("finalize.json"), target.appendingPathComponent("finalize.json")),
        ]
        // 这些稿件的批注:批注文件名是「synced:<文档标识>」的指纹(DocumentStore.annotationsFile)。
        // 稿件清单老位置、新位置都看:上次整理到一半退出时,清单可能已经搬过去了
        var docIds = Set(legacyDocIds)
        if let data = try? Data(contentsOf: target.appendingPathComponent("synced/index.json")),
           let moved = try? JSONDecoder().decode([SyncedDocument].self, from: data) { docIds.formUnion(moved.map(\.docId)) }
        if let data = try? Data(contentsOf: dataDirectory.appendingPathComponent("finalize.json")),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { docIds.formUnion(object.keys) }
        for docId in docIds {
            let name = "\(Hashing.sha256("synced:\(docId)")).annotations.json"
            moves.append((dataDirectory.appendingPathComponent("annotations/\(name)"), target.appendingPathComponent("annotations/\(name)")))
        }
        for (from, to) in moves where fileManager.fileExists(atPath: from.path) && !fileManager.fileExists(atPath: to.path) {
            do { try fileManager.moveItem(at: from, to: to) } catch { throw AccountError.adoptFailed(from.lastPathComponent) }
        }
    }

    func refresh() async {
        #if DEBUG
        if demoMode { return }
        #endif
        if syncing { return }
        syncing = true
        defer {
            syncing = false
            // 跑的时候账号变了:这一轮已经停下,按新账号再来一轮
            if refreshAgain { refreshAgain = false; Task { await self.refresh() } }
        }
        do {
            accountStatus = try await container.accountStatus()
            guard accountStatus == .available else {
                accountKey = nil // 登出期间可能换了账号:恢复后重新核对
                lastError = "未登录 iCloud,收不到 Mac 推来的文档。请在系统设置里登录与 Mac 相同的 Apple ID。"
                return
            }
            try await ensureAccount()
            let generation = accountGeneration
            await subscribeIfNeeded()
            await retryOutbox(generation: generation)
            try await pull(generation: generation)
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

    func pull(generation: Int) async throws {
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
            // 拉的时候账号变了:这一页不应用、不推进令牌(它属于原账号)
            guard generation == accountGeneration else { throw CancellationError() }
            for (_, result) in page.modificationResultsByID {
                guard case .success(let modification) = result else { continue }
                // 回执写不进手机就抛错:这一页不推进拉取进度,下次重拉(v2.4:手机应用回执可恢复)
                if try apply(record: modification.record) { touched = true }
            }
            for deletion in page.deletions where deletion.recordType == CloudSchema.reviewDocument {
                // 云端记录被删(Mac 的云端清理:定稿或作废满 30 天):手机上的副本留着、标「云端已清理」,用户自己从列表移除。
                // 手机可能没收到终态(Mac 那边同步程序停过),所以不看状态,一律留着
                let docId = deletion.recordID.recordName
                if let index = documents.firstIndex(where: { $0.docId == docId }), documents[index].cloudRemoved != true {
                    var next = documents
                    next[index].cloudRemoved = true
                    documents = next
                    touched = true
                }
            }
            saveToken(page.changeToken)
            cursor = page.changeToken
            moreComing = page.moreComing
        }
        if touched { saveIndex() }
    }

    /// 返回是否改动了本地状态
    private func apply(record: CKRecord) throws -> Bool {
        switch record.recordType {
        case CloudSchema.reviewDocument: return applyDocument(record)
        case CloudSchema.attachment: return applyAttachment(record)
        case CloudSchema.receipt: return try applyReceipt(record)
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
            let existingData = try? Data(contentsOf: target)
            let existing = existingData.map { Hashing.sha256($0) }
            let identity = { self.recordContentIdentity(docId: docId, hash: contentHash, reviewId: record["reviewId"] as? String ?? "", round: Int(record["round"] as? Int64 ?? 1)) }
            if existing == contentHash {
                identity()
            } else if let incoming = try? Data(contentsOf: source), Hashing.sha256(incoming) == contentHash {
                // 先校验再替换:新正文字节对上了才换(原子写入);换之前把旧正文留一份,回稿卡「显示改动」在本机对比
                if let existingData, let existing { keepPrevious(docId: docId, data: existingData, hash: existing) }
                do { try incoming.write(to: target, options: .atomic); identity() } catch { available = false }
            } else {
                // 字节对不上:不动旧正文(按它自己的身份只读显示),这一版当正文不可用,等下次重推
                available = false
            }
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
            outcome: record["outcome"] as? String,
            agentState: (record["agentState"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            results: (record["results"] as? String).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(RoundResults.self, from: $0) },
            macProtocol: (record["macProtocol"] as? Int64).map(Int.init)
        )
        // 一次换整个数组:先删后插会多发一次中间状态(那一刻这篇不在列表里),通知判断会被骗
        var next = documents.filter { $0.docId != docId }
        next.insert(item, at: 0)
        documents = next
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
        // 先校验再落盘:字节与清单里的指纹对不上就不写(旧文件原样留着),等下次重推
        guard let incoming = try? Data(contentsOf: source), sha.isEmpty || Hashing.sha256(incoming) == sha else { return false }
        do { try incoming.write(to: target, options: .atomic) } catch { return false }
        return true
    }

    private func applyReceipt(_ record: CKRecord) throws -> Bool {
        guard let batchId = record["batchId"] as? String else { return false }
        var ids: [String] = []
        if let json = record["acceptedIds"] as? String, let data = json.data(using: .utf8),
           let list = try? JSONSerialization.jsonObject(with: data) as? [String] { ids = list }
        let receipt = SyncReceipt(batchId: batchId, docId: record["docId"] as? String ?? "", reviewId: record["reviewId"] as? String ?? "",
                                  accepted: (record["accepted"] as? Int64 ?? 0) == 1, reason: record["reason"] as? String ?? "",
                                  message: record["message"] as? String ?? "", acceptedIds: ids, receivedAt: record["receivedAt"] as? Date,
                                  batchReviewId: record["batchReviewId"] as? String, baseVersion: record["baseVersion"] as? String,
                                  latestRound: (record["latestRound"] as? Int64).map(Int.init),
                                  intent: (record["intent"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                                  targetReviewId: (record["targetReviewId"] as? String).flatMap { $0.isEmpty ? nil : $0 })
        let data = try JSONEncoder().encode(receipt)
        try data.write(to: stateDir.appendingPathComponent("receipts/\(batchId).json"), options: .atomic)
        // 收到回执说明这批已经送达,待上传队列里的副本可以删了
        try? fileManager.removeItem(at: stateDir.appendingPathComponent("outbox/\(batchId).json"))
        pendingUploads = outboxFiles().count
        onReceipt?(receipt)
        return false
    }

    // MARK: 提交批次:AnnotationBatch(失败进待上传队列)

    /// 返回 true 表示已上传;false 表示暂存在待上传队列,联网后自动重试
    func submit(batch: AnnotationBatch) async -> Bool {
        guard let data = try? batch.asJSONData() else { return false }
        let base = accountBase
        let queued = stateDir.appendingPathComponent("outbox/\(batch.batchId).json")
        try? data.write(to: queued, options: .atomic)
        pendingUploads = outboxFiles().count
        // 先核对账号:换了账号(或查不到、或核对时又变了)就留在原账号的队列里,不投进别的账号
        let generation = accountGeneration
        guard (try? await ensureAccount()) != nil, accountBase == base, generation == accountGeneration else { return false }
        let uploaded = await upload(batchData: data)
        if uploaded {
            try? fileManager.removeItem(at: queued)
            pendingUploads = outboxFiles().count
        }
        return uploaded
    }

    /// 这个批次的快照还在待上传队列里
    func hasQueued(batchId: String) -> Bool {
        fileManager.fileExists(atPath: stateDir.appendingPathComponent("outbox/\(batchId).json").path)
    }

    private func outboxFiles() -> [URL] {
        (try? fileManager.contentsOfDirectory(at: stateDir.appendingPathComponent("outbox"), includingPropertiesForKeys: nil)) ?? []
    }

    func retryOutbox(generation: Int) async {
        for file in outboxFiles() {
            guard generation == accountGeneration else { return } // 账号变了:剩下的属于原账号,不传
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
        if let intent = object["intent"] as? String { record["intent"] = intent }
        // 批注列表缺失或不是数组:不上传,也不补成空列表(Mac 会把空列表当成零批注通过);留在队列里报错
        guard let annotations = object["annotations"] as? [Any], let json = try? JSONSerialization.data(withJSONObject: annotations) else {
            lastError = "有一批批注的列表读不出来,没有发出。请在批注列表里检查后重新交出。"
            return false
        }
        record["annotations"] = String(decoding: json, as: UTF8.self)
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
