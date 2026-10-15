import Foundation
import UIKit
import SwiftUI
import Combine
import UniformTypeIdentifiers
import CloudKit
import Network
import UserNotifications

/// 当前打开的文档(内存态)。
final class OpenedDocument: ObservableObject, Identifiable {
    let id = UUID()
    let url: URL
    @Published private(set) var name: String
    @Published private(set) var markdown: String
    @Published private(set) var hash: String
    @Published private(set) var assets: [String: String]      // 相对路径 → data: URL(能读到的同目录图片)
    /// 正文被整体替换(Mac 推来新版)的次数:页面据此重新加载正文
    @Published private(set) var contentVersion = 0
    /// 顶部一次性提示(如"已更新到第 2 轮新版"),几秒后自动消失
    @Published var notice: String?
    let securityScoped: Bool
    /// 批注文件的稳定键(本地文件按路径;Mac 推来的文档按文档标识)
    let storageKey: String
    /// Mac 推来的文档才有(跨端规则 2.1 节主线);nil 表示手机独立打开的文件(2.2 节副线)
    @Published var sync: SyncedDocument?
    /// Mac 已推来更新的版本,当前显示的还是旧版
    @Published var newerVersionAvailable = false
    /// 当前正文实际对应的轮次身份;只收到状态更新时不改挂(v2.3 第 5 节)
    @Published var contentReviewId: String?
    /// 这一轮能不能批注:状态允许,且正文字节就是这一轮的
    var annotationAllowed: Bool {
        guard let sync else { return true }
        if sync.cloudRemoved == true { return false } // 云端记录已清理:只读副本
        let ownRound = sync.contentHash == hash && contentReviewId == sync.reviewId
        if sync.canAnnotate { return ownRound }
        // v2.4 第 6.9 条:稿子回来后(终态),Mac 支持时手机上接着批,写的就是「为下一轮」的批注
        return writesNextRound && sync.contentAvailable && ownRound
    }
    /// 终态且 Mac 支持意图:新写的批注都是「为下一轮写的」
    var writesNextRound: Bool { sync.map { $0.isTerminal && $0.supportsIntents } ?? false }
    /// 已交出、还在等 Mac 开下一轮的「为下一轮写的」批注:回执没到,或回执到了但新一轮的快照还没到
    var nextRoundInFlight: [Note] {
        guard let sync else { return [] }
        return notes.filter { note in
            note.isNextRound && note.baseVersion == hash && note.reviewId == contentReviewId
                && (note.isSubmitted || (note.isReceived && note.acceptedReviewId != nil && note.acceptedReviewId != sync.reviewId))
        }
    }
    /// 批注归属用的轮次身份(本地独立文件没有)
    var roundId: String? { sync == nil ? nil : contentReviewId }
    @Published var notes: [Note]
    @Published var outline: [OutlineItem] = []

    init(url: URL, markdown: String, assets: [String: String], notes: [Note], securityScoped: Bool, storageKey: String, sync: SyncedDocument? = nil) {
        self.url = url
        self.name = sync?.title ?? url.lastPathComponent
        self.markdown = markdown
        // 指纹按实际字节算;Mac 推来的文档要和 Mac 的指纹对上才算"这一轮的正文"(跨端规则 v2.3 第 5 节:缓存绑定自己的身份)
        let computedHash = Hashing.sha256(markdown)
        self.hash = computedHash
        self.contentReviewId = (sync?.contentHash == computedHash) ? sync?.reviewId : nil
        self.assets = assets
        self.notes = notes
        self.securityScoped = securityScoped
        self.storageKey = storageKey
        self.sync = sync
    }

    deinit { if securityScoped { url.stopAccessingSecurityScopedResource() } }

    /// Mac 推来新版:就地换正文与附件,页面重载;旧版本上的批注按 6.6/6.7 只读保留(不高亮)
    func replaceContent(markdown: String, assets: [String: String], sync: SyncedDocument) {
        self.markdown = markdown
        self.assets = assets
        self.hash = Hashing.sha256(markdown)
        self.contentReviewId = (sync.contentHash == self.hash) ? sync.reviewId : nil
        self.name = sync.title
        self.sync = sync
        self.newerVersionAvailable = false
        self.contentVersion += 1
    }

    /// Mac 上改了名:标题跟着变(正文与批注身份不动)
    func retitle(_ title: String) { if !title.isEmpty && title != name { name = title } }

    /// 手机换新版前留下的上一版(回稿卡「显示改动」在本机对比);只有指纹核对过、且和现在这版不同才有
    var previous: (markdown: String, info: PreviousVersion)?

    /// 回稿卡(UI 方案 4.4):稿子回来了、正文就是这一轮的完成稿时才有;直到下一轮开始都在
    var returnCard: [String: Any]? {
        guard let sync, sync.phoneState == "completed", sync.outcome != "approved",
              contentReviewId == sync.reviewId, hash == sync.contentHash else { return nil }
        var card: [String: Any] = ["title": "第 \(sync.round) 轮回稿"]
        var meta: [String] = []
        if let pushedAt = sync.pushedAt {
            let formatter = DateFormatter()
            formatter.dateFormat = "M/d HH:mm"
            meta.append(formatter.string(from: pushedAt))
        }
        meta.append(sync.applyMode == "manual" ? "你在 Mac 上自己改的" : (sync.results?.actor ?? "AI 改的"))
        card["meta"] = meta.joined(separator: " · ")
        if !sync.summary.isEmpty { card["summary"] = sync.summary }
        if let results = sync.results {
            card["counts"] = ["applied": results.applied, "wontfix": results.wontfix]
            card["hasResults"] = !results.items.isEmpty
        }
        if let previous, previous.info.reviewId != sync.reviewId { card["note"] = "手机上没有这一轮的原稿,对比的是手机上的上一版。" }
        return card
    }
    /// 有回稿卡、又有上一版,才能「显示改动」
    var changesBase: String? { returnCard == nil ? nil : previous?.markdown }
    /// 回稿卡相关状态一变就要重画网页(如回稿后定稿:卡片收起)
    var cardKey: String { "\(sync?.reviewId ?? "")|\(sync?.phoneState ?? "")|\(previous?.info.hash ?? "")" }

    /// 当前版本上还没导出的批注:可改可删,"完成本轮"时打包。
    var openNotes: [Note] { notes.filter { $0.isOpen && $0.belongs(toVersion: hash, reviewId: roundId) && (!isTerminalView || $0.isNextRound) } }
    /// 正在看的是一轮的终态(稿子回来、定稿……):只有「为下一轮写的」算本轮可交的批注,上一轮遗留的没交批注当旧批注
    private var isTerminalView: Bool { sync?.isTerminal ?? false }
    /// 当前版本上已提交(导出 / 上传)的批注:锁定,等 Mac 接收。
    var submittedNotes: [Note] { notes.filter { $0.isSubmitted && $0.belongs(toVersion: hash, reviewId: roundId) } }
    /// Mac 已接收的批注(回执到达)。
    var receivedNotes: [Note] { notes.filter { $0.isReceived && $0.belongs(toVersion: hash, reviewId: roundId) } }
    /// Mac 拒收的批注:保留,由用户决定下一轮是否重提(跨端规则 6.6)。
    var rejectedNotes: [Note] { notes.filter { $0.isRejected && $0.belongs(toVersion: hash, reviewId: roundId) } }
    /// 本轮的批注条数(导航栏批注图标上的琥珀徽标):未交 + 已交出 + Mac 已收到
    var roundNotesCount: Int { openNotes.count + submittedNotes.count + receivedNotes.count }
    /// 写在旧版本或旧轮次上的批注:只读保留,不高亮、不再打包(v2.3 第 6.8 条:不改挂到新轮,显式"复制到本轮"才成为新批注)。
    var olderVersionNotes: [Note] {
        notes.filter { !$0.belongs(toVersion: hash, reviewId: roundId) || (isTerminalView && $0.isOpen && !$0.isNextRound) }
    }
    /// 交给正文高亮的批注:只画当前轮的(旧版本锚点对不上新正文);已提交、已接收的照样画出来。
    var highlightPayload: [[String: Any]] {
        notes.filter { $0.belongs(toVersion: hash, reviewId: roundId) && ($0.isOpen || $0.isSubmitted || $0.isReceived) }.map { note in
            var raw = note.raw
            raw["status"] = "open"
            return raw
        }
    }
}

/// 文档库:最近文件(书签)、打开/读取、批注本地持久化(先落盘再说)、批次导出。
@MainActor
final class DocumentStore: ObservableObject {
    @Published var recents: [RecentDocument] = []
    @Published var current: OpenedDocument?
    @Published var lastError: String?
    @Published var pendingShare: URL?
    /// App 自己文件夹里的 Markdown(「文件」→ 我的 iPhone → 回稿),首页直接列出,不必再走文件选择器。
    @Published var localFiles: [URL] = []

    /// Mac 推来的文档(跨端规则第 12 节),按最近更新排序
    @Published var synced: [SyncedDocument] = []
    @Published var syncError: String?
    @Published var pendingUploads = 0
    @Published var cloudAccount: CKAccountStatus = .couldNotDetermine
    @Published var lastPullAt: Date?
    @Published var syncing = false
    /// 没网:读稿页顶部一条灰线「离线 · 批注会先存在手机里」
    @Published var isOffline = false
    /// 手机上「看过」的记录:文档标识 → 会话标识|状态(DraftStatus.seenKey)。「新」与回稿蓝点靠它
    @Published private(set) var seen: [String: String] = [:]
    /// 从列表移除的稿件:文档标识 → 移除时的发布签名;Mac 再推新的发布就重新出现
    @Published private(set) var hidden: [String: String] = [:]
    /// 已经发过「回稿了」通知的:文档标识 → 会话标识|completed(同一次回稿只通知一次)
    private var notified: [String: String] = [:]
    /// 通知的起点:第一次完整拉取之后才通知;那一刻已经回来的稿子都算通知过(刚装、刚登录、升级后不补发旧通知)
    private var notifyBaseline = false
    /// 每篇 Mac 推来的稿子在手机上这一轮还没交的批注数(首页副标题用)
    @Published private(set) var localOpenCounts: [String: Int] = [:]
    /// App 在前台:只有前台时打开着的稿子才算"看过"
    var isActive = true
    private let pathMonitor = NWPathMonitor()

    private let fileManager = FileManager.default
    private var transport: SyncTransport = ExportTransport()
    let cloud: CloudSyncEngine
    private var cancellables: [AnyCancellable] = []

    init() {
        cloud = CloudSyncEngine(dataDirectory: Self.appDataDirectory())
        loadRecents()
        refreshLocalFiles()
        cloud.onReceipt = { [weak self] receipt in self?.apply(receipt: receipt) }
        // 换了 iCloud 账号(或第一次知道账号、把老位置的数据整理进账号目录):列表、批注、定稿请求都换成那个账号的;
        // 正开着的原账号稿件关掉;那个账号没处理完的回执与出站事务接着做
        cloud.onAccountSwitched = { [weak self] in
            guard let self else { return }
            if let docId = self.current?.sync?.docId, !self.cloud.documents.contains(where: { $0.docId == docId }) { self.current = nil }
            self.loadFinalizeRequests()
            self.reapplyPendingReceipts()
            self.recoverOutbound()
        }
        cloud.$documents.receive(on: RunLoop.main).sink { [weak self] docs in self?.syncedDocumentsChanged(docs) }.store(in: &cancellables)
        cloud.$lastError.receive(on: RunLoop.main).sink { [weak self] error in self?.syncError = error }.store(in: &cancellables)
        cloud.$pendingUploads.receive(on: RunLoop.main).sink { [weak self] count in self?.pendingUploads = count }.store(in: &cancellables)
        cloud.$accountStatus.receive(on: RunLoop.main).sink { [weak self] status in self?.cloudAccount = status }.store(in: &cancellables)
        cloud.$lastPullAt.receive(on: RunLoop.main).sink { [weak self] date in
            self?.lastPullAt = date
            if date != nil { self?.establishNotifyBaseline() }
        }.store(in: &cancellables)
        cloud.$syncing.receive(on: RunLoop.main).sink { [weak self] value in self?.syncing = value }.store(in: &cancellables)
        loadSeen()
        loadFinalizeRequests()
        reapplyPendingReceipts()
        recoverOutbound()
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let offline = path.status != .satisfied
            Task { @MainActor in if self?.isOffline != offline { self?.isOffline = offline } }
        }
        pathMonitor.start(queue: DispatchQueue(label: "draftback.network"))
    }

    // MARK: 看过 / 从列表移除(只在这台手机上,不影响 Mac)

    private var seenFile: URL { dataDirectory.appendingPathComponent("seen.json") }

    private func loadSeen() {
        guard let data = try? Data(contentsOf: seenFile),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // 第一次用这一版:手头已有的稿件都算看过,免得升级后满屏「新」和蓝点
            seen = Dictionary(uniqueKeysWithValues: cloud.documents.map { ($0.docId, DraftStatus.seenKey(for: $0)) })
            saveSeen()
            return
        }
        seen = object["seen"] as? [String: String] ?? [:]
        hidden = object["hidden"] as? [String: String] ?? [:]
        notified = object["notified"] as? [String: String] ?? [:]
        notifyBaseline = object["notifyBaseline"] as? Bool ?? false
    }

    private func saveSeen() {
        let object: [String: Any] = ["version": 1, "seen": seen, "hidden": hidden, "notified": notified, "notifyBaseline": notifyBaseline]
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: seenFile, options: .atomic)
        }
    }

    func markSeen(_ doc: SyncedDocument) {
        let key = DraftStatus.seenKey(for: doc)
        guard seen[doc.docId] != key else { return }
        seen[doc.docId] = key
        saveSeen()
        updateBadge()
        // 看过了:这篇的「回稿了」通知从通知中心收掉
        Self.withdrawNotification(docId: doc.docId)
    }

    // MARK: 稿子回来的通知与图标角标(UI 方案 4.4;手机拉到新版时自己发,不需要 Mac 改动)

    /// 第一次打开 Mac 推来的稿子时问一次通知权限(系统只弹一次)
    func requestNotificationPermissionIfNeeded() {
        #if DEBUG
        if cloud.demoMode { return } // 模拟器截图时不弹系统权限框
        #endif
        guard !Self.notificationsAsked else { return }
        UserDefaults.standard.set(true, forKey: Self.notificationsAskedKey)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
            Task { @MainActor in self.updateBadge() }
        }
    }

    /// 问过通知权限没有。没问过之前一概不碰通知中心:新系统上连查授权状态都会提前弹权限框
    nonisolated static let notificationsAskedKey = "draftback.notifications.asked.v1"
    nonisolated static var notificationsAsked: Bool { UserDefaults.standard.bool(forKey: notificationsAskedKey) }

    /// 收掉某篇的「回稿了」通知;还没允许通知时什么都不碰(碰了系统可能提前弹权限框)
    nonisolated static func withdrawNotification(docId: String) {
        guard notificationsAsked else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus != .notDetermined else { return }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["return-\(docId)"])
        }
    }

    /// 角标 = 新推来还没打开的一轮 + 回稿还没看的(打开就消)
    func updateBadge() {
        let count = synced.filter { doc in
            guard !isHidden(doc) else { return false }
            let row = DraftStatus.row(for: doc, seen: seen[doc.docId])
            return row.isNew || row.unread
        }.count
        // 还没问过 / 没允许时不碰角标:系统会因此弹权限框,时机就不对了(权限只在第一次打开 Mac 推来的稿子时问)
        guard Self.notificationsAsked else { return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus), settings.badgeSetting == .enabled else { return }
            UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
        }
    }

    private func establishNotifyBaseline() {
        guard !notifyBaseline else { return }
        for doc in synced where doc.phoneState == "completed" { notified[doc.docId] = "\(doc.reviewId)|completed" }
        notifyBaseline = true
        saveSeen()
    }

    private func notifyReturns(new docs: [SyncedDocument]) {
        // 第一次完整拉取之前不发(那时到的都是旧稿子)
        guard notifyBaseline else { return }
        var changed = false
        for doc in docs where doc.phoneState == "completed" && doc.outcome != "approved" && !isHidden(doc) {
            let key = "\(doc.reviewId)|completed"
            if notified[doc.docId] == key || seen[doc.docId] == key { continue }
            notified[doc.docId] = key
            changed = true
            // 正在看这篇:不打扰
            if isActive, current?.sync?.docId == doc.docId { continue }
            let content = UNMutableNotificationContent()
            content.title = "《\(doc.title.replacingOccurrences(of: ".md", with: ""))》回稿了"
            let firstLine = doc.summary.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            let counts = doc.results.map { "采纳 \($0.applied) · 未采纳 \($0.wontfix)" }
            let detail = firstLine.isEmpty ? "第 \(doc.round) 轮改完了,点开看看。" : String(firstLine.prefix(80))
            content.body = counts.map { "\($0)。\(detail)" } ?? detail
            content.sound = .default
            content.userInfo = ["docId": doc.docId]
            content.threadIdentifier = doc.docId
            let request = UNNotificationRequest(identifier: "return-\(doc.docId)", content: content, trigger: nil)
            if Self.notificationsAsked { UNUserNotificationCenter.current().add(request) { _ in } }
        }
        if changed { saveSeen() }
    }

    /// 点通知:直接打开那一篇;冷启动时稿件列表还没到,先记下,到了再开
    private var pendingOpenDocId: String?
    func openSynced(docId: String) {
        guard let doc = synced.first(where: { $0.docId == docId }) else { pendingOpenDocId = docId; return }
        pendingOpenDocId = nil
        if current?.sync?.docId == docId { return }
        openSynced(doc)
    }

    private static func hiddenKey(_ doc: SyncedDocument) -> String { "\(doc.reviewId)|\(doc.phoneState)|\(doc.revision ?? -1)" }
    func isHidden(_ doc: SyncedDocument) -> Bool { hidden[doc.docId] == Self.hiddenKey(doc) }
    func hide(_ doc: SyncedDocument) {
        hidden[doc.docId] = Self.hiddenKey(doc)
        saveSeen()
        updateBadge()
        Self.withdrawNotification(docId: doc.docId)
    }

    private func recountLocalOpen() {
        var counts: [String: Int] = [:]
        for doc in synced {
            let notes = (current?.storageKey == "synced:\(doc.docId)") ? current!.notes : loadNotes(forKey: "synced:\(doc.docId)")
            let open = notes.filter { $0.isOpen && $0.belongs(toVersion: doc.contentHash, reviewId: doc.reviewId) }.count
            if open > 0 { counts[doc.docId] = open }
        }
        if counts != localOpenCounts { localOpenCounts = counts }
    }

    /// 启动、回到前台、收到静默推送时:拉取 Mac 推来的文档与回执,重试待上传的批次
    func refreshSync() { Task { await cloud.refresh() } }

    // MARK: 目录

    /// 用户自己的文档:「文件」App → 我的 iPhone → 回稿。
    private var documentsDirectory: URL {
        fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    /// App 内部数据(批注、最近文件)放在 Application Support:随 iCloud 备份,但不出现在「文件」App 里,
    /// 免得被当成普通文件误删误改。
    static func appDataDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("Draftback", isDirectory: true)
        // 改名前的目录(命名沿革见 docs/naming-history.md):第一次遇到就整个搬过来
        let legacy = base.appendingPathComponent("MDTurn", isDirectory: true)
        if !FileManager.default.fileExists(atPath: url.path), FileManager.default.fileExists(atPath: legacy.path) {
            try? FileManager.default.moveItem(at: legacy, to: url)
        }
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private var dataDirectory: URL { Self.appDataDirectory() }
    private var annotationsDirectory: URL {
        let url = dataDirectory.appendingPathComponent("annotations", isDirectory: true)
        try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    /// Mac 推来的稿件的批注跟着 iCloud 账号放(跨端规则第 9 节):accounts/<账号>/annotations/;本机文件的批注照旧放在 annotations/
    private var syncedAnnotationsDirectory: URL {
        let url = cloud.accountBase.appendingPathComponent("annotations", isDirectory: true)
        try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private var recentsFile: URL { dataDirectory.appendingPathComponent("recent.json") }

    /// 文档的稳定键。iOS 更新或重装 App 时会换沙盒路径,所以 App 自己的文件夹(Documents)
    /// 和随 App 自带的示例文档用相对路径;iCloud 云盘、其他 App 的文件夹等外部位置用完整路径。
    func documentKey(for url: URL) -> String {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        let roots: [(String, URL)] = [("documents", documentsDirectory), ("bundle", Bundle.main.bundleURL)]
        for (label, root) in roots {
            let base = root.standardizedFileURL.resolvingSymlinksInPath().path
            if path.hasPrefix(base + "/") { return "\(label):" + String(path.dropFirst(base.count + 1)) }
        }
        return path
    }

    /// 批注文件按"文档稳定键的 SHA-256"命名,与文档内容版本无关;每条批注自带它所依据的版本指纹。
    private func annotationsFile(forKey key: String) -> URL {
        (key.hasPrefix("synced:") ? syncedAnnotationsDirectory : annotationsDirectory).appendingPathComponent("\(Hashing.sha256(key)).annotations.json")
    }

    // MARK: App 文件夹

    func refreshLocalFiles() {
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        let items = (try? fileManager.contentsOfDirectory(at: documentsDirectory, includingPropertiesForKeys: keys,
                                                          options: [.skipsHiddenFiles])) ?? []
        func modified(_ url: URL) -> Date {
            (try? url.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast
        }
        localFiles = items
            .filter { ["md", "markdown"].contains($0.pathExtension.lowercased()) }
            .sorted { modified($0) > modified($1) }
    }

    func openLocal(named name: String) {
        refreshLocalFiles()
        guard let url = localFiles.first(where: { $0.lastPathComponent == name }) else {
            lastError = "App 文件夹里没有《\(name)》。"
            return
        }
        open(url: url, fromExternal: true)
    }

    // MARK: 最近文件

    private func loadRecents() {
        guard let data = try? Data(contentsOf: recentsFile),
              let items = try? JSONDecoder().decode([RecentDocument].self, from: data) else { return }
        recents = items
    }

    private func saveRecents() {
        if let data = try? JSONEncoder().encode(recents) { try? data.write(to: recentsFile, options: .atomic) }
    }

    private func remember(url: URL) {
        guard let bookmark = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) else { return }
        let entry = RecentDocument(id: Hashing.sha256(documentKey(for: url)), name: url.lastPathComponent, bookmark: bookmark,
                                   lastOpenedAt: Date(), directoryHint: url.deletingLastPathComponent().lastPathComponent)
        recents.removeAll { $0.id == entry.id }
        recents.insert(entry, at: 0)
        recents = Array(recents.prefix(30))
        saveRecents()
    }

    func forget(_ recent: RecentDocument) {
        recents.removeAll { $0.id == recent.id }
        saveRecents()
    }

    func open(recent: RecentDocument) {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: recent.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            lastError = "找不到《\(recent.name)》,它可能已被移动或删除。"
            return
        }
        open(url: url, fromExternal: true)
    }

    // MARK: 打开

    /// 打开示例文档(随 App 自带,首次使用与模拟器演示用)。
    func openSample() {
        guard let url = Bundle.main.url(forResource: "示例文档", withExtension: "md") else { lastError = "示例文档缺失。"; return }
        open(url: url, fromExternal: false)
    }

    func open(url: URL, fromExternal: Bool) {
        let scoped = fromExternal && url.startAccessingSecurityScopedResource()
        do {
            let data = try Data(contentsOf: url)
            guard let markdown = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) else {
                throw NSError(domain: "Draftback", code: 1, userInfo: [NSLocalizedDescriptionKey: "文件不是 UTF-8 文本。"])
            }
            let assets = Self.collectAssets(markdown: markdown, around: url)
            let key = documentKey(for: url)
            let document = OpenedDocument(url: url, markdown: markdown, assets: assets, notes: loadNotes(forKey: key), securityScoped: scoped, storageKey: key)
            if fromExternal { remember(url: url) }
            current = document
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            lastError = "打开失败:\(error.localizedDescription)"
        }
    }

    func close() { current = nil }

    /// 尽力读取文档引用的同目录图片(iOS 对单文件授权通常不含同目录,读不到就留占位,跨端规则第 5 节)。
    private static func collectAssets(markdown: String, around url: URL) -> [String: String] {
        var assets: [String: String] = [:]
        // 行内图片 `![](pic.png)` 与引用式定义 `[ref]: pic.png`(引用式图片渲染出来也是 <img src="pic.png">)
        // 地址可以写在尖括号里(允许空格):第一组是尖括号里的,第二组是普通写法
        let patterns = [#"!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))"#, #"(?m)^\s{0,3}\[[^\]]+\]:\s*(?:<([^>\n]+)>|([^\s<>]+))"#]
        let regexes = patterns.compactMap { try? NSRegularExpression(pattern: $0) }
        let base = url.deletingLastPathComponent()
        let text = markdown as NSString
        let matches = regexes.flatMap { $0.matches(in: markdown, range: NSRange(location: 0, length: text.length)) }
        for match in matches {
            let group = match.range(at: 1).location != NSNotFound ? 1 : 2
            let rawPath = text.substring(with: match.range(at: group))
            if rawPath.hasPrefix("http") || rawPath.hasPrefix("data:") { continue }
            let key = rawPath.removingPercentEncoding ?? rawPath
            if assets[key] != nil { continue }
            let fileURL = base.appendingPathComponent(key)
            guard let data = try? Data(contentsOf: fileURL), data.count <= 20 * 1024 * 1024 else { continue }
            let mime: String
            switch fileURL.pathExtension.lowercased() {
            case "png": mime = "image/png"
            case "jpg", "jpeg": mime = "image/jpeg"
            case "gif": mime = "image/gif"
            case "svg": mime = "image/svg+xml"
            case "webp": mime = "image/webp"
            default: continue
            }
            assets[key] = "data:\(mime);base64,\(data.base64EncodedString())"
        }
        return assets
    }

    // MARK: 批注持久化

    private func loadNotes(forKey key: String) -> [Note] {
        guard let data = try? Data(contentsOf: annotationsFile(forKey: key)),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = object["annotations"] as? [[String: Any]] else { return [] }
        return list.map { Note(raw: $0) }
    }

    @discardableResult
    private func persistNotes(_ document: OpenedDocument) -> Bool {
        let object: [String: Any] = [
            "version": 1,
            "document": ["name": document.name, "hash": document.hash],
            "annotations": document.notes.map { $0.raw },
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else {
            lastError = "批注没能存进手机(编码失败)。请再试一次。"
            return false
        }
        do {
            try data.write(to: annotationsFile(forKey: document.storageKey), options: .atomic)
        } catch {
            // 跨端规则 6.1:写失败要明确反馈,不能当成已保存
            lastError = "批注没能存进手机:\(error.localizedDescription)"
            return false
        }
        if document.sync != nil { recountLocalOpen() }
        return true
    }

    /// 返回是否已存进手机(先落盘再说:写失败就撤回,不显示成已保存)
    @discardableResult
    func add(note: Note, to document: OpenedDocument) -> Bool {
        var raw = note.raw
        raw["baseVersion"] = document.hash
        // 创建时固定轮次身份(v2.3 第 6.1 条);本地独立文件没有。Mac 推来的稿子只有这一轮正文才能批注
        if let sync = document.sync {
            guard document.annotationAllowed else { lastError = "这一轮现在不能批注。"; return false }
            raw["docId"] = sync.docId
            raw["reviewId"] = sync.reviewId
            // 稿子回来后写的:为下一轮写,创建时就标(v2.4 第 6.9 条),之后不改
            if document.writesNextRound { raw["intent"] = "next-round" }
        }
        let added = Note(raw: raw)
        document.notes.insert(added, at: 0)
        if !persistNotes(document) {
            document.notes.removeAll { $0.id == added.id }
            return false
        }
        return true
    }

    /// 复制到本轮(跨端规则第 6.8 条、v2.4 第 6.9 条):新 ID、本轮身份、sourceNoteId 指回原条;原记录不改。
    /// 引文在本轮正文里找不到时复制成总体意见,带上原引文
    @discardableResult
    func copyToRound(_ note: Note, anchor: [String: Any]?, in document: OpenedDocument) -> Bool {
        let copy: Note
        if let anchor, !note.isDocumentScope {
            copy = Note.make(anchor: anchor, quote: note.quote, comment: note.comment, scope: nil)
        } else {
            let comment = note.isDocumentScope || note.quote.isEmpty ? note.comment : "「\(note.quote)」\(note.comment)"
            copy = Note.make(anchor: nil, quote: "", comment: comment, scope: "document")
        }
        var raw = copy.raw
        raw["sourceNoteId"] = note.id
        return add(note: Note(raw: raw), to: document)
    }

    @discardableResult
    func update(noteId: String, comment: String, in document: OpenedDocument) -> Bool {
        guard let index = document.notes.firstIndex(where: { $0.id == noteId }), document.notes[index].isOpen else { return false }
        let before = document.notes[index]
        document.notes[index].raw["comment"] = comment
        document.notes[index].raw["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        if persistNotes(document) { return true }
        if let restore = document.notes.firstIndex(where: { $0.id == noteId }) { document.notes[restore] = before }
        return false
    }

    func remove(noteId: String, from document: OpenedDocument) {
        let before = document.notes
        document.notes.removeAll { $0.id == noteId && $0.isOpen }
        if !persistNotes(document) { document.notes = before }
    }

    // MARK: 完成本轮:打包批次

    /// 打包当前版本上未导出的批注。成功后这些批注标为"已导出"并锁定(跨端规则 6.2),
    /// 下一次导出不会再带上它们;分享被取消时可用 resubmitBatch 按原批次编号重发,Mac 按编号去重。
    func submitBatch(for document: OpenedDocument) {
        let open = document.openNotes
        guard !open.isEmpty else { lastError = "这一轮还没有批注。"; return }
        let batchId = UUID().uuidString.lowercased()
        let completedAt = ISO8601DateFormatter().string(from: Date())
        let intent: String? = (document.sync != nil && open.allSatisfy { $0.isNextRound }) ? "next-round" : nil
        guard let batch = makeBatch(open, id: batchId, completedAt: completedAt, document: document, intent: intent) else { return }
        // 出站事务(v2.4 第 6.9 条):先把批注标为已交出(记批次编号与时间)并落盘,再存批次快照、上传;
        // 中途被杀,启动时按原批次编号补发(recoverOutbound)。落盘失败就不发
        let ids = Set(open.map { $0.id })
        let before = document.notes
        for index in document.notes.indices where ids.contains(document.notes[index].id) {
            document.notes[index].raw["status"] = "submitted"
            document.notes[index].raw["submittedBatchId"] = batchId
            document.notes[index].raw["submittedAt"] = completedAt
        }
        guard persistNotes(document) else { document.notes = before; return }
        if document.sync != nil {
            // Mac 推来的文档:批次走 iCloud(失败进待上传队列,联网后自动重试),不走分享面板;底栏显示「等待同步」,不弹错误
            Task { _ = await cloud.submit(batch: batch) }
        } else {
            do {
                pendingShare = try transport.submit(batch: batch)
            } catch {
                lastError = "打包批注失败:\(error.localizedDescription)"
            }
        }
    }

    // MARK: 定稿请求(v2.4 第 6.9 条:finalize 意图)

    struct FinalizeRequest: Codable, Equatable {
        var batchId: String
        var docId: String
        var reviewId: String
        var baseVersion: String
        var completedAt: String
        var title: String
        var rejectedReason: String? = nil
    }
    /// 文档标识 → 在途或被拒的定稿请求;回执接受后清掉
    @Published private(set) var finalizeRequests: [String: FinalizeRequest] = [:]
    private var finalizeFile: URL { cloud.accountBase.appendingPathComponent("finalize.json") } // 跟着 iCloud 账号放
    private func loadFinalizeRequests() {
        finalizeRequests = [:]
        guard let data = try? Data(contentsOf: finalizeFile),
              let items = try? JSONDecoder().decode([String: FinalizeRequest].self, from: data) else { return }
        finalizeRequests = items
    }
    @discardableResult
    private func saveFinalizeRequests() -> Bool {
        guard let data = try? JSONEncoder().encode(finalizeRequests) else { return false }
        do { try data.write(to: finalizeFile, options: .atomic); return true } catch { return false }
    }
    private func finalizeBatch(_ request: FinalizeRequest) -> AnnotationBatch {
        AnnotationBatch(batchId: request.batchId, documentName: request.title, baseVersion: request.baseVersion, completedAt: request.completedAt,
                        device: UIDevice.current.name, annotationsJSON: "[]", docId: request.docId, reviewId: request.reviewId, intent: "finalize")
    }
    /// 手机定稿:先记「定稿在途」并落盘,再存快照、上传。expected 是弹确认框时那一轮的身份与指纹:
    /// 确认前 Mac 推来了新的一轮(或正文变了),这次确认作废,不替你给没看过的一轮定稿
    func requestFinalize(for document: OpenedDocument, expected: (reviewId: String, hash: String)) {
        guard let sync = document.sync, sync.supportsIntents else { lastError = "Mac 上的回稿需要更新,才能在手机上定稿。"; return }
        guard sync.reviewId == expected.reviewId, document.hash == expected.hash else { lastError = "确认期间这篇有了新的一轮,这次没有定稿。先看看新的一轮。"; return }
        let request = FinalizeRequest(batchId: UUID().uuidString.lowercased(), docId: sync.docId, reviewId: sync.reviewId, baseVersion: document.hash,
                                      completedAt: ISO8601DateFormatter().string(from: Date()), title: document.name)
        let before = finalizeRequests
        finalizeRequests[sync.docId] = request
        guard saveFinalizeRequests() else { finalizeRequests = before; lastError = "定稿请求没能存进手机,没有发出。请再试一次。"; return }
        let batch = finalizeBatch(request)
        Task { _ = await cloud.submit(batch: batch) }
    }

    /// 启动时补发:已交出但没有回执、也没有待上传快照的批注,按原批次编号重建再发;定稿在途同理
    private func recoverOutbound() {
        for doc in cloud.documents {
            let notes = loadNotes(forKey: "synced:\(doc.docId)")
            let groups = Dictionary(grouping: notes.filter { $0.isSubmitted && $0.submittedBatchId != nil }, by: { $0.submittedBatchId! })
            for (batchId, members) in groups where cloud.receipt(for: batchId) == nil && !cloud.hasQueued(batchId: batchId) {
                guard let first = members.first, let docId = first.docId, let reviewId = first.reviewId, let base = first.baseVersion else { continue }
                let restored = members.map { note -> [String: Any] in
                    var raw = note.raw
                    raw["status"] = "open"
                    raw.removeValue(forKey: "submittedBatchId"); raw.removeValue(forKey: "submittedAt")
                    return raw
                }
                guard let data = try? JSONSerialization.data(withJSONObject: restored), let json = String(data: data, encoding: .utf8) else { continue }
                let batch = AnnotationBatch(batchId: batchId, documentName: doc.title, baseVersion: base, completedAt: first.raw["submittedAt"] as? String ?? "",
                                            device: UIDevice.current.name, annotationsJSON: json, docId: docId, reviewId: reviewId,
                                            intent: members.allSatisfy { $0.isNextRound } ? "next-round" : nil)
                Task { _ = await cloud.submit(batch: batch) }
            }
        }
        for request in finalizeRequests.values where request.rejectedReason == nil && cloud.receipt(for: request.batchId) == nil && !cloud.hasQueued(batchId: request.batchId) {
            let batch = finalizeBatch(request)
            Task { _ = await cloud.submit(batch: batch) }
        }
    }

    /// 重新导出最近一批(同一批次编号、同样内容),用于分享面板被取消或传输失败后重发。
    func resubmitBatch(for document: OpenedDocument) {
        let submitted = document.submittedNotes
        guard let last = submitted.compactMap({ note -> (String, String)? in
            guard let id = note.submittedBatchId else { return nil }
            return (id, note.raw["submittedAt"] as? String ?? "")
        }).max(by: { $0.1 < $1.1 }) else { lastError = "没有已导出的批次。"; return }
        let notes = submitted.filter { $0.submittedBatchId == last.0 }.map { note -> Note in
            var raw = note.raw
            raw["status"] = "open"
            raw.removeValue(forKey: "submittedBatchId")
            raw.removeValue(forKey: "submittedAt")
            return Note(raw: raw)
        }
        let intent: String? = (document.sync != nil && notes.allSatisfy { $0.isNextRound }) ? "next-round" : nil
        guard let batch = makeBatch(notes, id: last.0, completedAt: last.1, document: document, intent: intent) else { return }
        if document.sync != nil {
            Task { _ = await cloud.submit(batch: batch) }
            return
        }
        do { pendingShare = try transport.submit(batch: batch) }
        catch { lastError = "打包批注失败:\(error.localizedDescription)" }
    }

    private func makeBatch(_ notes: [Note], id: String, completedAt: String, document: OpenedDocument, intent: String? = nil) -> AnnotationBatch? {
        guard let data = try? JSONSerialization.data(withJSONObject: notes.map { $0.raw }),
              let json = String(data: data, encoding: .utf8) else { lastError = "打包批注失败。"; return nil }
        // 外层身份取自批注自己创建时固定的身份(v2.3 第 6.2 条),不用当前会话身份覆盖;本地独立文件没有身份,批次是 version 1
        let first = notes.first
        let docId = document.sync == nil ? nil : (first?.docId ?? document.sync?.docId)
        let reviewId = document.sync == nil ? nil : (first?.reviewId ?? document.contentReviewId)
        return AnnotationBatch(batchId: id, documentName: document.name, baseVersion: first?.baseVersion ?? document.hash,
                               completedAt: completedAt, device: UIDevice.current.name, annotationsJSON: json,
                               docId: docId, reviewId: reviewId, intent: intent)
    }

    // MARK: Mac 推来的文档(跨端规则第 12 节)

    func openSynced(_ doc: SyncedDocument) {
        let url = cloud.contentURL(for: doc.docId)
        guard let data = try? Data(contentsOf: url), let markdown = String(data: data, encoding: .utf8) else {
            lastError = "《\(doc.title)》的正文还没有同步下来,稍后再试。"
            return
        }
        let key = "synced:\(doc.docId)"
        let document = OpenedDocument(url: url, markdown: markdown, assets: Self.collectAssets(markdown: markdown, around: url),
                                      notes: loadNotes(forKey: key), securityScoped: false, storageKey: key, sync: doc)
        document.previous = loadPrevious(doc.docId, currentHash: document.hash)
        current = document
        markSeen(doc)
        requestNotificationPermissionIfNeeded()
    }

    /// 读上一版:指纹核对过、且和现在这版不同才算
    private func loadPrevious(_ docId: String, currentHash: String) -> (markdown: String, info: PreviousVersion)? {
        guard let info = cloud.previousVersion(for: docId), info.hash != currentHash,
              let data = try? Data(contentsOf: cloud.previousURL(for: docId)), Hashing.sha256(data) == info.hash,
              let markdown = String(data: data, encoding: .utf8) else { return nil }
        return (markdown, info)
    }

    private func syncedDocumentsChanged(_ docs: [SyncedDocument]) {
        synced = docs
        recountLocalOpen()
        notifyReturns(new: docs)
        updateBadge()
        if let pending = pendingOpenDocId, docs.contains(where: { $0.docId == pending }) { openSynced(docId: pending) }
        guard let document = current, let sync = document.sync, let latest = docs.first(where: { $0.docId == sync.docId }) else { return }
        if latest.contentHash != sync.contentHash && latest.contentAvailable {
            // 手头没有未提交的批注:新版直接换进来,不用退出再进;有未提交的批注(锚在旧正文上)才留给用户点「新版」
            if document.openNotes.isEmpty { loadLatestVersion(latest, into: document) } else { document.newerVersionAvailable = true }
        } else if latest.reviewId != sync.reviewId && latest.contentAvailable && latest.contentHash == document.hash {
            // 正文一字不差但换了一轮(零批注通过再开轮、恢复到相同内容):字节已通过本轮指纹,直接把正文身份挂到新轮;
            // 手头有旧轮未提交的批注就先留「新版」入口,旧批注保留原身份
            if document.openNotes.isEmpty {
                document.sync = latest
                document.retitle(latest.title)
                document.contentReviewId = latest.reviewId
                document.notice = "已进入第 \(latest.round) 轮"
            } else {
                document.newerVersionAvailable = true
            }
        } else {
            // 状态变了而正文没变(或只推了状态、新正文不可用):就地更新元数据;正文身份 contentReviewId 不改挂,
            // 指纹对不上时 annotationAllowed 自然为 false(v2.3 第 5 节)
            document.sync = latest
            document.retitle(latest.title)
        }
        // 前台、而且正在看的就是这一版,才算看过;还留着旧正文(手头有没交的批注)时新版保持未读
        if isActive, document.sync?.reviewId == latest.reviewId, document.hash == latest.contentHash { markSeen(latest) }
    }

    /// 把 Mac 推来的最新正文换进当前打开的文档(供自动更新与「新版」按钮共用)
    func loadLatestVersion(_ latest: SyncedDocument, into document: OpenedDocument) {
        let url = cloud.contentURL(for: latest.docId)
        guard let data = try? Data(contentsOf: url), let markdown = String(data: data, encoding: .utf8) else {
            document.newerVersionAvailable = true
            return
        }
        document.previous = loadPrevious(latest.docId, currentHash: Hashing.sha256(markdown))
        document.replaceContent(markdown: markdown, assets: Self.collectAssets(markdown: markdown, around: url), sync: latest)
        // 稿子回来:正文最上方有回稿卡,不再闪一条提示;其他情况(恢复、新一轮的正文变了)提示一句
        document.notice = document.returnCard != nil ? nil : "已换成第 \(latest.round) 轮的正文"
    }

    /// Mac 的回执到了:对应批次的批注标为"Mac 已接收"或"未被采用(原因)"(跨端规则 6.5、6.6)。
    /// 批注落盘成功才标「回执已应用」;没标的启动时再来一遍(v2.4 第 6.9 条:手机应用回执可恢复)
    private func apply(receipt: SyncReceipt) {
        // 定稿请求没有批注可挂:按批次编号认领;接受就清掉,拒收记下原因给界面
        if let entry = finalizeRequests.first(where: { $0.value.batchId == receipt.batchId }) {
            let before = finalizeRequests
            if receipt.accepted { finalizeRequests[entry.key] = nil } else { finalizeRequests[entry.key]?.rejectedReason = Self.rejectionText(receipt) }
            // 存不进去就退回内存里的状态、不标已应用:下次启动重放这张回执
            if saveFinalizeRequests() { cloud.markReceiptApplied(receipt.batchId) } else { finalizeRequests = before }
            return
        }
        // 定稿回执、请求已经不在了(上次已经应用、「已应用」标记没存上;或原因看过已收起):没有要改的,补标已应用
        if receipt.intent == "finalize" { cloud.markReceiptApplied(receipt.batchId); return }
        // 批注文件读不到:不标已应用,启动时再来
        if applyReceiptToNotes(receipt) { cloud.markReceiptApplied(receipt.batchId) }
    }

    /// 被拒的定稿请求,看过原因后收起
    func dismissFinalizeRejection(docId: String) {
        guard finalizeRequests[docId]?.rejectedReason != nil else { return }
        finalizeRequests[docId] = nil
        saveFinalizeRequests()
    }

    private func reapplyPendingReceipts() {
        for receipt in cloud.unappliedReceipts() { apply(receipt: receipt) }
    }

    @discardableResult
    private func applyReceiptToNotes(_ receipt: SyncReceipt) -> Bool {
        let key = "synced:\(receipt.docId)"
        var matched = false
        let mutate: (inout [Note]) -> Void = { notes in
            for index in notes.indices where notes[index].submittedBatchId == receipt.batchId && (notes[index].isSubmitted || notes[index].isRejected) {
                matched = true
                if receipt.accepted && receipt.acceptedIds.contains(notes[index].id) {
                    notes[index].raw["status"] = "received"
                    notes[index].raw.removeValue(forKey: "rejectedReason")
                    // next-round:创建身份不变,另记 Mac 新开的那一轮(v2.4 第 6.9 条)
                    if let target = receipt.targetReviewId, notes[index].isNextRound { notes[index].raw["acceptedReviewId"] = target }
                } else {
                    notes[index].raw["status"] = "rejected"
                    notes[index].raw["rejectedReason"] = receipt.accepted ? "Mac 已有同编号的批注,没有重复写入" : Self.rejectionText(receipt)
                    notes[index].raw["rejectedCode"] = receipt.accepted ? "duplicate" : receipt.reason
                }
                notes[index].raw["receiptAt"] = ISO8601DateFormatter().string(from: receipt.receivedAt ?? Date())
            }
        }
        // 读得到批注、却没有这批的(已经应用过,或这批批注已被删掉):没有要改的,算应用成功
        if let document = current, document.storageKey == key {
            var notes = document.notes
            mutate(&notes)
            guard matched else { return true }
            document.notes = notes
            return persistNotes(document)
        }
        let file = annotationsFile(forKey: key)
        if fileManager.fileExists(atPath: file.path) {
            // 文件在却读不出来:不当成「没有这批」,留着回执下次再来
            guard let data = try? Data(contentsOf: file), (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { return false }
        }
        var notes = loadNotes(forKey: key)
        mutate(&notes)
        guard matched else { return true }
        let object: [String: Any] = ["version": 1, "annotations": notes.map { $0.raw }]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return false }
        do { try data.write(to: annotationsFile(forKey: key), options: .atomic); return true } catch { return false }
    }

    /// 回执的拒收原因:Mac 写的说明优先;没有就按原因代码给一句人话
    nonisolated static func rejectionText(_ receipt: SyncReceipt) -> String {
        let message = receipt.message.trimmingCharacters(in: .whitespacesAndNewlines)
        if !message.isEmpty { return message }
        switch receipt.reason {
        case "round-advanced": return "Mac 上已经是新的一轮,这批写在旧一轮上"
        case "session-advanced": return "这一轮在 Mac 上已经交出或结束"
        case "version-mismatch": return "Mac 上的原文和手机上的不一样了"
        case "missing-identity": return "手机上的回稿版本太旧,请更新"
        case "no-session": return "Mac 上找不到这篇的审阅"
        case "invalid-batch": return "Mac 上的回稿需要更新,才能收这类请求"
        case "user-editing": return "Mac 上正在编辑这篇,等编辑完再交"
        case "has-open-notes": return "Mac 上这篇还有没处理的批注,先在 Mac 上处理"
        default: return receipt.reason.isEmpty ? "Mac 没有收下" : "Mac 没有收下(\(receipt.reason))"
        }
    }

    #if DEBUG
    /// 仅调试版:模拟器截图用的演示稿件(--demo-drafts)。各种状态各一篇,不连 iCloud。
    func seedDemo() {
        let now = Date()
        func body(_ title: String) -> String {
            """
            # \(title.replacingOccurrences(of: ".md", with: ""))

            回稿把同一份文档在 Mac 和 iPhone 之间来回传。这份说明讲清楚谁说了算、批注怎么走。

            ## 谁说了算

            Mac 管原文、轮次和最终状态。手机管自己还没交出去的批注。云端只是邮筒,不做裁判。

            ## 批注怎么走

            手机上写的每一条先存在手机里,强退也不丢。点「交给 AI」才打包上传。Mac 收到后回一张回执。

            ## 出了岔子怎么办

            Mac 上的原文被别的程序改了,这批批注不会被采用。它们留在手机上,不会丢。

            | 状态 | 谁推进 |
            | --- | --- |
            | 已交出 | 手机 |
            | AI 正在修改 | Mac |
            """
        }
        func doc(_ id: String, _ title: String, round: Int, state: String, outcome: String? = nil, agent: String? = nil,
                 summary: String = "", minutes: Double) -> (doc: SyncedDocument, markdown: String) {
            let markdown = body(title)
            let item = SyncedDocument(docId: id, reviewId: "r_\(id)_\(round)", title: title, round: round, status: "", applyMode: "",
                                      phoneState: state, contentHash: Hashing.sha256(markdown), summary: summary, openCount: 0,
                                      pushedAt: now.addingTimeInterval(-minutes * 60), pusher: "Mac", contentAvailable: true,
                                      updatedAt: now, revision: 1, outcome: outcome, agentState: agent, macProtocol: 3)
            return (item, markdown)
        }
        var items = [
            doc("demo-rules", "跨端规则.md", round: 2, state: "reviewing", minutes: 3),
            doc("demo-plan", "产品方案.md", round: 3, state: "completed", summary: "按 3 条批注改了第二节的说法,删掉一段重复的背景。", minutes: 12),
            doc("demo-interview", "访谈记录.md", round: 1, state: "completed", outcome: "approved", minutes: 200),
            doc("demo-weekly", "周报.md", round: 1, state: "waiting-agent", agent: "listening", minutes: 6),
            doc("demo-release", "发布说明.md", round: 2, state: "applying", agent: "claimed", minutes: 4),
            doc("demo-pricing", "定价页.md", round: 1, state: "conflict", minutes: 30),
            doc("demo-annual", "年度总结.md", round: 4, state: "finalized", minutes: 60 * 26),
            doc("demo-draft", "旧草稿.md", round: 1, state: "cancelled", minutes: 60 * 24 * 5),
        ]
        items[1].doc.results = RoundResults(applied: 2, wontfix: 1, total: 3, actor: "Claude Code", items: [
            .init(id: "n1", scope: "text", quote: "Mac 管原文、轮次和最终状态。", you: "把「最终状态」说清楚是谁定的。", ai: "补了一句:定稿只在 Mac 上落盘。", status: "applied"),
            .init(id: "n2", scope: "text", quote: "云端只是邮筒,不做裁判。", you: "这个比喻好,保留。", ai: "未采纳:原文已经是这样,没有改。", status: "wontfix"),
            .init(id: "n3", scope: "document", quote: "", you: "最后一节再举个具体例子。", ai: "在「出了岔子怎么办」里加了断网重传的例子。", status: "applied"),
        ])
        // 产品方案:手机上留着这一轮的原稿,回稿卡能「显示改动」
        let planOriginal = items[1].markdown
            .replacingOccurrences(of: "Mac 管原文、轮次和最终状态。", with: "Mac 管原文和轮次。")
            .replacingOccurrences(of: "点「交给 AI」才打包上传。", with: "点「完成本轮」才打包上传,上传失败会自动重试。")
            + "\n## 以后再说\n\n多台 Mac 对一台手机,首版不做。\n"
        cloud.seedDemo(items, previous: ["demo-plan": planOriginal])
        seen = ["demo-plan": "seen-before", "demo-interview": DraftStatus.seenKey(for: items[2].doc)]
        hidden = [:]
        saveSeen()
        // 跨端规则:手机上两条没交的批注
        if let rules = items.first?.doc {
            func note(_ comment: String, quote: String, scope: String?) -> [String: Any] {
                var raw = Note.make(anchor: nil, quote: quote, comment: comment, scope: scope).raw
                raw["baseVersion"] = rules.contentHash
                raw["docId"] = rules.docId
                raw["reviewId"] = rules.reviewId
                return raw
            }
            let object: [String: Any] = ["version": 1, "annotations": [
                note("「邮筒」这个比喻好懂,保留。", quote: "云端只是邮筒,不做裁判。", scope: nil),
                note("最后一节再举个具体例子。", quote: "", scope: "document"),
            ]]
            if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]) {
                try? data.write(to: annotationsFile(forKey: "synced:\(rules.docId)"), options: .atomic)
            }
        }
        recountLocalOpen()
    }
    #endif

    func sharePDF(_ data: Data, name: String) {
        let url = fileManager.temporaryDirectory.appendingPathComponent(name.replacingOccurrences(of: ".md", with: "") + ".pdf")
        do { try data.write(to: url, options: .atomic); pendingShare = url }
        catch { lastError = "导出 PDF 失败:\(error.localizedDescription)" }
    }
}
