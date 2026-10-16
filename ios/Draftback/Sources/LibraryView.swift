import SwiftUI
import UniformTypeIdentifiers
import CloudKit

/// 首页:按「轮到谁」分组的稿件收件箱(分组规则与 Mac 左栏一致)。
///   轮到你 / 已交出 / 已结束:Mac 上开始审阅的稿件,经 iCloud 推来
///   本机文件:从「文件」App 打开的、放进 App 文件夹的、示例文档;只在这台手机,不同步
/// 方案 C:皮面打底,每个大类是一张纸卡;标题在一条浅色带上,和下面的稿子分开,右边是带字的「收起」「展开」;
/// 每一行前面一盏指示灯(红绿灯);右上角文件夹与设置;搜索在最下面。
struct LibraryView: View {
    @EnvironmentObject private var store: DocumentStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.cover) private var cover
    @Environment(\.colorScheme) private var scheme
    @State private var importing = false
    @State private var showSettings = false
    @State private var query = ""
    @FocusState private var searching: Bool
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

    private func groupLight(_ group: DraftGroup) -> Light {
        switch group {
        case .yours: return .go
        case .handed: return .wait
        case .ended: return .off
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 14) {
                        header
                        if showsAccountCard { accountCard }
                        let groups = drafts
                        if groups.isEmpty && query.isEmpty { emptyCard }
                        ForEach(DraftGroup.allCases) { group in
                            if let items = groups[group], !items.isEmpty { groupCard(group, items) }
                        }
                        let local = localEntries
                        if !local.isEmpty { localCard(local) }
                        if !query.isEmpty && groups.isEmpty && local.isEmpty {
                            Text("没有找到「\(query)」").font(.subheadline).foregroundStyle(leatherInk.secondary).padding(.top, 20)
                        }
                        syncFooter.id("sync-footer")
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.interactively)
                .refreshable { store.refreshSync() }
                #if DEBUG
                // 仅调试版:截图时滚到最底(--demo-scroll-bottom)、全部展开(--demo-expand-all)、全部收起(--demo-collapse-all)、打开设置(--demo-settings)
                .onAppear {
                    if CommandLine.arguments.contains("--demo-expand-all") { collapsedStore = "" }
                    if CommandLine.arguments.contains("--demo-collapse-all") { collapsedStore = "ended,handed,local,yours" }
                    if CommandLine.arguments.contains("--demo-scroll-bottom") {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { withAnimation { proxy.scrollTo("sync-footer", anchor: .bottom) } }
                    }
                    if CommandLine.arguments.contains("--demo-settings") { showSettings = true }
                    if let index = CommandLine.arguments.firstIndex(of: "--demo-search"), index + 1 < CommandLine.arguments.count { query = CommandLine.arguments[index + 1] }
                }
                #endif
            }
            .background(LeatherSurface(deep: true).ignoresSafeArea())
            .safeAreaInset(edge: .bottom) { searchBar }
            .toolbar(.hidden, for: .navigationBar)
            .onAppear { store.refreshLocalFiles() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { store.refreshLocalFiles() } }
            .navigationDestination(item: $store.current) { document in ReaderView(document: document) }
            .navigationDestination(isPresented: $showSettings) { SettingsView() }
            .fileImporter(isPresented: $importing, allowedContentTypes: markdownTypes, allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first { store.open(url: url, fromExternal: true) }
            }
            .alert("出错了", isPresented: Binding(get: { store.lastError != nil && store.current == nil }, set: { if !$0 { store.lastError = nil } })) {
                Button("好", role: .cancel) {}
            } message: { Text(store.lastError ?? "") }
        }
    }

    private var leatherInk: LeatherInk { LeatherInk(cover: cover, scheme: scheme) }

    // MARK: 顶上:回稿 + 文件夹 + 设置

    private var header: some View {
        HStack(spacing: 12) {
            Text("回稿")
                .font(SkinFont.serif(30, bold: true, relativeTo: .largeTitle))
                .kerning(6)
                .foregroundStyle(leatherInk.primary)
                .shadow(color: leatherInk.shadow, radius: 0.5, y: 1)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button { importing = true } label: { RoundIcon(systemName: "folder") }
                .buttonStyle(RaisedButtonStyle(shape: .circle))
                .accessibilityLabel("从「文件」打开")
            Button { showSettings = true } label: { RoundIcon(systemName: "gearshape") }
                .buttonStyle(RaisedButtonStyle(shape: .circle))
                .accessibilityLabel("设置")
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    // MARK: 大类:一张纸卡,标题在一条浅色带上

    private func groupCard(_ group: DraftGroup, _ items: [DraftItem]) -> some View {
        let key = group.rawValue
        let collapsed = isCollapsed(key)
        return VStack(spacing: 0) {
            band(group.title, key: key, light: groupLight(group), count: items.count,
                 unread: items.contains { $0.state.unread }, preview: items.first?.doc.title, collapsed: collapsed)
            if !collapsed {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { DottedRule().padding(.horizontal, 14) }
                    Button { store.openSynced(item.doc) } label: { DraftRowView(title: item.doc.title, state: item.state) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button { store.hide(item.doc) } label: { Label("从列表移除", systemImage: "eye.slash") }
                        }
                        .accessibilityAction(named: "从列表移除") { store.hide(item.doc) }
                }
            }
        }
        .paperCard()
    }

    private func localCard(_ local: [LocalEntry]) -> some View {
        let collapsed = isCollapsed("local")
        return VStack(alignment: .leading, spacing: 0) {
            band("本机文件", key: "local", light: .off, count: local.count, unread: false, preview: localPreview(local), collapsed: collapsed)
            if !collapsed {
                ForEach(Array(local.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 { DottedRule().padding(.horizontal, 14) }
                    localRow(entry)
                }
                Text("只在这台手机上,不会同步到 Mac。「文件」App → 我的 iPhone → \(appFolderName) 里的 Markdown 也列在这里。")
                    .font(.footnote).foregroundStyle(Skin.muted)
                    .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 12)
            }
        }
        .paperCard()
    }

    /// 大类的标题带(2026-10-15 用户提:大类和下面的稿子要分开、收起展开的按钮要明显):
    /// 指示灯、名字、篇数;收起时写最新一篇的标题;右边带字的「收起 / 展开」。整条都能点
    private func band(_ title: String, key: String, light: Light, count: Int, unread: Bool, preview: String?, collapsed: Bool) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { toggle(key) }
        } label: {
            HStack(spacing: 9) {
                IndicatorLight(light: light)
                Text(title).font(SkinFont.serif(18, bold: true, relativeTo: .headline)).foregroundStyle(Skin.inkStrong)
                Text("\(count)").font(.subheadline.monospacedDigit()).foregroundStyle(Skin.muted)
                if collapsed, let preview {
                    Text(preview).font(.footnote).foregroundStyle(Skin.muted).lineLimit(1).padding(.leading, 2)
                }
                Spacer(minLength: 6)
                if collapsed && unread { UnreadDot(size: 8) }
                if query.isEmpty {
                    HStack(spacing: 3) {
                        Text(collapsed ? "展开" : "收起")
                        Image(systemName: collapsed ? "chevron.down" : "chevron.up").font(.caption2.weight(.bold))
                    }
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 11).frame(minHeight: 28)
                    .modifier(RaisedLook())
                }
            }
            .padding(.horizontal, 14).frame(minHeight: 54)
            .background(Skin.band)
            .overlay(alignment: .bottom) { if !collapsed { Rectangle().fill(Skin.rule).frame(height: 1) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!query.isEmpty)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: collapsed ? 6 : 0, bottomTrailingRadius: collapsed ? 6 : 0, topTrailingRadius: 6, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title),\(count) 篇\(collapsed && unread ? ",有新的" : "")")
        .accessibilityValue(collapsed ? "已收起" : "已展开")
        .accessibilityHint(query.isEmpty ? (collapsed ? "点按展开" : "点按收起") : "")
        .accessibilityAddTraits(.isButton)
    }

    private var emptyCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                IndicatorLight(light: .go)
                Text("轮到你").font(SkinFont.serif(18, bold: true, relativeTo: .headline)).foregroundStyle(Skin.inkStrong)
                Spacer()
            }
            .padding(.horizontal, 14).frame(minHeight: 54)
            .background(Skin.band)
            Rectangle().fill(Skin.rule).frame(height: 1)
            Text("Mac 上开始审阅的文档会自动出现在这里。")
                .font(.subheadline).foregroundStyle(Skin.muted)
                .padding(14)
        }
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .paperCard()
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

    /// 没登录 iCloud:顶部一张说明卡(图钉钉住);本机文件照常能用
    @ViewBuilder private var accountCard: some View {
        switch store.cloudAccount {
        case .noAccount, .restricted:
            VStack(alignment: .leading, spacing: 10) {
                Label("登录与 Mac 相同的 Apple ID,手机才能收到稿子", systemImage: "icloud.slash")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Skin.inkStrong)
                Text("本机文件照常能用。").font(.footnote).foregroundStyle(Skin.muted)
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } label: { Text("打开设置").font(.subheadline.weight(.semibold)).padding(.horizontal, 16).frame(minHeight: 34) }
                .buttonStyle(RaisedButtonStyle())
            }
            .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .paperCard()
            .overlay(alignment: .top) { Image("Pin").resizable().frame(width: 26, height: 26).offset(y: -9).accessibilityHidden(true) }
            .padding(.top, 6)
        case .temporarilyUnavailable:
            Label("iCloud 暂时不可用,稍后会自动重试", systemImage: "icloud.slash")
                .font(.subheadline).foregroundStyle(Skin.ink)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .paperCard()
        default:
            EmptyView()
        }
    }

    private var syncFooter: some View {
        let failed = store.syncError != nil && store.cloudAccount != .noAccount
        return VStack(spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: store.syncError == nil ? "icloud" : "exclamationmark.icloud")
                Text(syncLine).lineLimit(2)
            }
            .foregroundStyle(failed ? Skin.color(0xE5483B) : leatherInk.secondary)
            Text("Mac 上开始审阅的文档会自动出现在这里。").foregroundStyle(leatherInk.secondary)
        }
        .font(.footnote)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, 2)
    }

    private var syncLine: String {
        if store.cloudAccount == .noAccount { return "未登录 iCloud" }
        if let error = store.syncError { return error }
        if store.syncing && store.lastPullAt == nil { return "正在同步…" }
        if let date = store.lastPullAt { return "iCloud 已同步 · \(TimeText.clock(date))" }
        return "iCloud"
    }

    // MARK: 最下面的搜索

    private var searchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(Skin.muted)
            TextField("", text: $query, prompt: Text("搜索稿件和本机文件").foregroundStyle(Skin.muted))
                .focused($searching)
                .submitLabel(.search)
                .foregroundStyle(Skin.ink)
            if !query.isEmpty {
                Button { query = ""; searching = false } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Skin.muted) }
                    .accessibilityLabel("清除搜索")
            }
        }
        .font(.body)
        .padding(.horizontal, 16).frame(height: 46)
        .background(Capsule().fill(LinearGradient(colors: [Skin.btnPress1, Skin.btnPress2], startPoint: .top, endPoint: .bottom)))
        .overlay(Capsule().stroke(Color.black.opacity(0.14), lineWidth: 0.75))
        .overlay(Capsule().stroke(Color.black.opacity(0.12), lineWidth: 2).blur(radius: 1.5).offset(y: 1).mask(Capsule()))
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 6)
        // 搜索框下面垫一条皮面:往上滚的纸卡从它底下过,不会从搜索框四周露出来
        .background(
            LeatherSurface(deep: true)
                .shadow(color: scheme == .dark ? .black.opacity(0.4) : Skin.color(cover.shade, alpha: 0.22), radius: 4, y: -2)
                .ignoresSafeArea(edges: .bottom)
        )
    }

    @ViewBuilder private func localRow(_ entry: LocalEntry) -> some View {
        switch entry {
        case .recent(let recent):
            Button { store.open(recent: recent) } label: {
                LocalRowView(name: recent.name, detail: "\(recent.directoryHint) · \(TimeText.clock(recent.lastOpenedAt))")
            }
            .buttonStyle(.plain)
            .contextMenu { Button { store.forget(recent) } label: { Label("从列表移除", systemImage: "eye.slash") } }
            .accessibilityAction(named: "从列表移除") { store.forget(recent) }
        case .folder(let url):
            Button { store.open(url: url, fromExternal: true) } label: { LocalRowView(name: url.lastPathComponent, detail: appFolderName) }
                .buttonStyle(.plain)
        case .sample:
            Button { store.openSample() } label: { LocalRowView(name: "示例文档.md", detail: "随 App 自带,随便批") }
                .buttonStyle(.plain)
        }
    }
}

/// 不是按钮、但看上去是凸起的米白按钮块(大类标题带右边的「收起 / 展开」:整条标题带都能点)
struct RaisedLook: ViewModifier {
    @Environment(\.cover) private var cover
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .foregroundStyle(Skin.btnText)
            .background(Capsule().fill(LinearGradient(colors: [Skin.btn1, Skin.btn2], startPoint: .top, endPoint: .bottom)))
            .overlay(Capsule().stroke(Skin.btnEdge, lineWidth: 0.75))
            .shadow(color: scheme == .dark ? .black.opacity(0.4) : Skin.color(cover.shade, alpha: 0.3), radius: 1.2, y: 1)
    }
}

/// 稿件一行:指示灯、文件名、副标题;行尾「新」或未读蓝点。AI 正在改时黄灯一闪一闪
struct DraftRowView: View {
    let title: String
    let state: DraftRowState

    var body: some View {
        HStack(spacing: 12) {
            IndicatorLight(light: state.tone.light, blinking: state.spinning)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(SkinFont.serif(16, bold: true)).foregroundStyle(Skin.inkStrong).lineLimit(1)
                Text(state.subtitle).font(.footnote).foregroundStyle(state.tone.light == .stop ? Skin.warn : Skin.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            if state.isNew {
                Text("新").font(.caption.weight(.bold)).foregroundStyle(.white)
                    .padding(.horizontal, 8).frame(minHeight: 20)
                    .background(Capsule().fill(Light.unread))
            }
            if state.unread { UnreadDot() }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
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
            IndicatorLight(light: .off)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(SkinFont.serif(16, bold: true)).foregroundStyle(Skin.inkStrong).lineLimit(1)
                Text(detail).font(.footnote).foregroundStyle(Skin.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

extension OpenedDocument: Hashable {
    static func == (lhs: OpenedDocument, rhs: OpenedDocument) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
