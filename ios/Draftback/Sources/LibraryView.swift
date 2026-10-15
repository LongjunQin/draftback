import SwiftUI
import UniformTypeIdentifiers
import CloudKit

/// 首页:按「轮到谁」分组的稿件收件箱(UI 方案第 4.2 节,分组规则与 Mac 左栏一致)。
///   轮到你 / 已交出 / 已结束:Mac 上开始审阅的稿件,经 iCloud 推来
///   本机文件:从「文件」App 打开的、放进 App 文件夹的、示例文档;只在这台手机,不同步
struct LibraryView: View {
    @EnvironmentObject private var store: DocumentStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var importing = false
    @State private var query = ""
    /// 收起的大类(2026-10-15 用户提:已结束越积越长,大类要能收起、点开)。默认收起「已结束」与「本机文件」,
    /// 「轮到你」「已交出」展开;用户点过就记住。搜索时全部展开,搜到的不会藏在收起的大类里
    @AppStorage("library.collapsedSections") private var collapsedStore = "ended,local"

    /// 「文件」App 里显示的文件夹名就是 App 的显示名(测试版是「回稿 测试」)。
    private var appFolderName: String {
        (Bundle.main.localizedInfoDictionary?["CFBundleDisplayName"] as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? "回稿"
    }

    private var markdownTypes: [UTType] {
        var types: [UTType] = [.plainText, .text]
        if let md = UTType(filenameExtension: "md") { types.insert(md, at: 0) }
        if let markdown = UTType("net.daringfireball.markdown") { types.insert(markdown, at: 0) }
        return types
    }

    private struct DraftItem: Identifiable {
        let doc: SyncedDocument
        let state: DraftRowState
        var id: String { doc.docId }
    }

    private func matches(_ text: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return needle.isEmpty || text.localizedCaseInsensitiveContains(needle)
    }

    /// 每组按最后推送时间排,新的在上
    private var drafts: [DraftGroup: [DraftItem]] {
        let now = Date()
        var buckets: [DraftGroup: [DraftItem]] = [:]
        for doc in store.synced where !store.isHidden(doc) && matches(doc.title) {
            let state = DraftStatus.row(for: doc, seen: store.seen[doc.docId], localOpen: store.localOpenCounts[doc.docId] ?? 0, now: now)
            buckets[state.group, default: []].append(DraftItem(doc: doc, state: state))
        }
        for key in buckets.keys {
            buckets[key]?.sort { ($0.doc.pushedAt ?? .distantPast) > ($1.doc.pushedAt ?? .distantPast) }
        }
        return buckets
    }

    private enum LocalEntry: Identifiable {
        case recent(RecentDocument)
        case folder(URL)
        case sample
        var id: String {
            switch self {
            case .recent(let item): return "recent:\(item.id)"
            case .folder(let url): return "folder:\(url.path)"
            case .sample: return "sample"
            }
        }
    }

    /// 最近打开的在前;App 文件夹里还没打开过的接着列;示例文档放最后
    private var localEntries: [LocalEntry] {
        let recentIds = Set(store.recents.map(\.id))
        var entries: [LocalEntry] = store.recents.filter { matches($0.name) }.map { .recent($0) }
        for url in store.localFiles where !recentIds.contains(Hashing.sha256(store.documentKey(for: url))) && matches(url.lastPathComponent) {
            entries.append(.folder(url))
        }
        if matches("示例文档.md") { entries.append(.sample) }
        return entries
    }

    private var collapsedKeys: Set<String> { Set(collapsedStore.split(separator: ",").map(String.init)) }
    private func isCollapsed(_ key: String) -> Bool { query.isEmpty && collapsedKeys.contains(key) }
    private func toggle(_ key: String) {
        var keys = collapsedKeys
        if keys.contains(key) { keys.remove(key) } else { keys.insert(key) }
        collapsedStore = keys.sorted().joined(separator: ",")
    }

    /// 大类卡片的第一行(2026-10-15 用户提:全收起时只剩几行灰字,太简陋):彩色图标、名字、收起时写最新一篇的标题,
    /// 右边篇数(轮到你用实心徽标)与箭头;收起时里面有没看过的带一个蓝点。点一下收起 / 展开,稿件列在同一张卡片里
    private func categoryRow(_ title: String, key: String, icon: String, tone: Tone, count: Int, unread: Bool, preview: String?, emphasize: Bool = false) -> some View {
        let collapsed = isCollapsed(key)
        return Button {
            withAnimation(.easeInOut(duration: 0.2)) { toggle(key) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(tone.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).foregroundStyle(.primary)
                    if collapsed, let preview {
                        Text(preview).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if collapsed && unread { Circle().fill(Palette.unread).frame(width: 8, height: 8) }
                if emphasize && count > 0 {
                    Text("\(count)").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(.white)
                        .padding(.horizontal, 8).frame(minWidth: 24, minHeight: 22)
                        .background(tone.color, in: Capsule())
                } else {
                    Text("\(count)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!query.isEmpty)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title),\(count) 篇\(collapsed && unread ? ",有新的" : "")")
        .accessibilityValue(collapsed ? "已收起" : "已展开")
        .accessibilityHint(query.isEmpty ? (collapsed ? "点按展开" : "点按收起") : "")
        .accessibilityAddTraits(.isButton)
    }

    private func groupIcon(_ group: DraftGroup) -> (String, Tone) {
        switch group {
        case .yours: return ("tray.full.fill", .turn)
        case .handed: return ("paperplane.fill", .ai)
        case .ended: return ("checkmark.seal.fill", .done)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
            List {
                if showsAccountCard { Section { accountCard } }
                let groups = drafts
                if groups.isEmpty && query.isEmpty {
                    Section("轮到你") {
                        Text("Mac 上开始审阅的文档会自动出现在这里。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                ForEach(DraftGroup.allCases) { group in
                    if let items = groups[group], !items.isEmpty {
                        Section {
                            let (icon, tone) = groupIcon(group)
                            categoryRow(group.title, key: group.rawValue, icon: icon, tone: tone, count: items.count,
                                        unread: items.contains { $0.state.unread }, preview: items.first?.doc.title, emphasize: group == .yours)
                            if !isCollapsed(group.rawValue) {
                                ForEach(items) { item in
                                    Button { store.openSynced(item.doc) } label: { DraftRowView(title: item.doc.title, state: item.state) }
                                        .swipeActions {
                                            Button { store.hide(item.doc) } label: { Label("从列表移除", systemImage: "eye.slash") }
                                                .tint(.gray)
                                        }
                                }
                            }
                        }
                    }
                }
                let local = localEntries
                if !local.isEmpty {
                    Section {
                        categoryRow("本机文件", key: "local", icon: "iphone", tone: .waiting, count: local.count, unread: false, preview: localPreview(local))
                        if !isCollapsed("local") {
                            ForEach(local) { entry in localRow(entry) }
                        }
                    } footer: {
                        if !isCollapsed("local") {
                            Text("只在这台手机上,不会同步到 Mac。「文件」App → 我的 iPhone → \(appFolderName) 里的 Markdown 也列在这里。")
                        }
                    }
                }
                Section {} footer: { syncFooter.id("sync-footer") }
            }
            .listStyle(.insetGrouped)
            #if DEBUG
            // 仅调试版:截图时滚到最底(--demo-scroll-bottom)、全部展开(--demo-expand-all)、全部收起(--demo-collapse-all)
            .onAppear {
                if CommandLine.arguments.contains("--demo-expand-all") { collapsedStore = "" }
                if CommandLine.arguments.contains("--demo-collapse-all") { collapsedStore = "ended,handed,local,yours" }
                if CommandLine.arguments.contains("--demo-scroll-bottom") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { withAnimation { proxy.scrollTo("sync-footer", anchor: .bottom) } }
                }
            }
            #endif
            }
            .navigationTitle("回稿")
            .searchable(text: $query, prompt: "搜索稿件和本机文件")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { importing = true } label: { Image(systemName: "folder") }
                        .accessibilityLabel("从「文件」打开")
                }
            }
            .refreshable { store.refreshSync() }
            .onAppear { store.refreshLocalFiles() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { store.refreshLocalFiles() } }
            .navigationDestination(item: $store.current) { document in ReaderView(document: document) }
            .fileImporter(isPresented: $importing, allowedContentTypes: markdownTypes, allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first { store.open(url: url, fromExternal: true) }
            }
            .alert("出错了", isPresented: Binding(get: { store.lastError != nil && store.current == nil }, set: { if !$0 { store.lastError = nil } })) {
                Button("好", role: .cancel) {}
            } message: { Text(store.lastError ?? "") }
        }
    }

    private func localPreview(_ entries: [LocalEntry]) -> String? {
        switch entries.first {
        case .recent(let item): return item.name
        case .folder(let url): return url.lastPathComponent
        case .sample: return "示例文档.md"
        case nil: return nil
        }
    }

    private var showsAccountCard: Bool {
        [.noAccount, .restricted, .temporarilyUnavailable].contains(store.cloudAccount)
    }

    /// 没登录 iCloud:顶部一张卡;本机文件照常能用
    @ViewBuilder private var accountCard: some View {
        switch store.cloudAccount {
        case .noAccount, .restricted:
            VStack(alignment: .leading, spacing: 10) {
                Label("登录与 Mac 相同的 Apple ID,手机才能收到稿子", systemImage: "icloud.slash")
                    .font(.subheadline.weight(.semibold))
                Text("本机文件照常能用。").font(.footnote).foregroundStyle(.secondary)
                Button("打开设置") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(.bordered)
            }
            .padding(.vertical, 4)
        case .temporarilyUnavailable:
            Label("iCloud 暂时不可用,稍后会自动重试", systemImage: "icloud.slash")
                .font(.subheadline)
        default:
            EmptyView()
        }
    }

    private var syncFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: store.syncError == nil ? "icloud" : "exclamationmark.icloud")
                Text(syncLine).lineLimit(2)
            }
            .foregroundStyle(store.syncError == nil || store.cloudAccount == .noAccount ? Color.secondary : Tone.conflict.text)
            Text("Mac 上开始审阅的文档会自动出现在这里。")
        }
        .font(.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var syncLine: String {
        if store.cloudAccount == .noAccount { return "未登录 iCloud" }
        if let error = store.syncError { return error }
        if store.syncing && store.lastPullAt == nil { return "正在同步…" }
        if let date = store.lastPullAt { return "iCloud 已同步 · \(TimeText.clock(date))" }
        return "iCloud"
    }

    @ViewBuilder private func localRow(_ entry: LocalEntry) -> some View {
        switch entry {
        case .recent(let recent):
            Button { store.open(recent: recent) } label: {
                LocalRowView(name: recent.name, detail: "\(recent.directoryHint) · \(TimeText.clock(recent.lastOpenedAt))")
            }
            .swipeActions { Button { store.forget(recent) } label: { Label("从列表移除", systemImage: "eye.slash") }.tint(.gray) }
        case .folder(let url):
            Button { store.open(url: url, fromExternal: true) } label: { LocalRowView(name: url.lastPathComponent, detail: appFolderName) }
        case .sample:
            Button { store.openSample() } label: { LocalRowView(name: "示例文档.md", detail: "随 App 自带,随便批") }
        }
    }
}

/// 稿件一行:状态圆点、文件名、副标题;行尾「新」、未读蓝点或转圈
struct DraftRowView: View {
    let title: String
    let state: DraftRowState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(state.tone.color).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(Color.primary).lineLimit(1)
                Text(state.subtitle).font(.footnote).foregroundStyle(Color.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if state.isNew {
                Text("新").font(.caption.weight(.bold)).foregroundStyle(.white)
                    .padding(.horizontal, 8).frame(minHeight: 22)
                    .background(Capsule().fill(Tone.turn.color))
            }
            if state.unread { Circle().fill(Palette.unread).frame(width: 9, height: 9) }
            if state.spinning {
                if reduceMotion { Image(systemName: "sparkles").foregroundStyle(Tone.ai.color) } else { ProgressView().controlSize(.small).tint(Tone.ai.color) }
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("《\(title)》,\(state.spoken)")
        .accessibilityAddTraits(.isButton)
    }
}

struct LocalRowView: View {
    let name: String
    let detail: String
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.text").foregroundStyle(Tone.idle.color).frame(width: 10)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.body).foregroundStyle(Color.primary).lineLimit(1)
                Text(detail).font(.footnote).foregroundStyle(Color.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

extension OpenedDocument: Hashable {
    static func == (lhs: OpenedDocument, rhs: OpenedDocument) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
