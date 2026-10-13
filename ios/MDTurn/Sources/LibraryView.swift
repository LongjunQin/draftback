import SwiftUI
import UniformTypeIdentifiers

/// 文件库:打开文件、最近文件、示例文档。打开后进入 ReaderView。
struct LibraryView: View {
    @EnvironmentObject private var store: DocumentStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var importing = false

    /// 「文件」App 里显示的文件夹名就是 App 的显示名(测试版是「MDTurn 测试」)。
    private var appFolderName: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? "MDTurn"
    }

    private var markdownTypes: [UTType] {
        var types: [UTType] = [.plainText, .text]
        if let md = UTType(filenameExtension: "md") { types.insert(md, at: 0) }
        if let markdown = UTType("net.daringfireball.markdown") { types.insert(markdown, at: 0) }
        return types
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { importing = true } label: { Label("打开 Markdown…", systemImage: "folder") }
                    Button { store.openSample() } label: { Label("打开示例文档", systemImage: "doc.text") }
                }
                if !store.synced.isEmpty || store.syncError != nil {
                    Section {
                        if let error = store.syncError {
                            Text(error).font(.caption).foregroundStyle(.red)
                        }
                        ForEach(store.synced) { doc in
                            Button { store.openSynced(doc) } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(doc.title).foregroundStyle(.primary)
                                    Text("第 \(doc.round) 轮 · \(doc.stateLabel)" + (doc.pushedAt.map { " · \($0.formatted(date: .abbreviated, time: .shortened))" } ?? ""))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .disabled(!doc.contentAvailable)
                        }
                    } header: {
                        Text("来自 Mac")
                    } footer: {
                        Text("Mac 上发起审阅的文档会自动出现在这里;点「完成本轮」后批注直接交回 Mac。")
                    }
                }
                if !store.localFiles.isEmpty {
                    Section {
                        ForEach(store.localFiles, id: \.self) { url in
                            Button { store.open(url: url, fromExternal: true) } label: {
                                Label(url.lastPathComponent, systemImage: "doc.richtext")
                            }
                        }
                    } header: {
                        Text("MDTurn 文件夹")
                    } footer: {
                        Text("「文件」App → 我的 iPhone → \(appFolderName) 里的 Markdown 会列在这里。")
                    }
                }
                Section("最近文件") {
                    if store.recents.isEmpty {
                        Text("还没有打开过文件。从「文件」App 选择一篇 .md,或在其他 App 里分享到 MDTurn。").foregroundStyle(.secondary)
                    }
                    ForEach(store.recents) { recent in
                        Button { store.open(recent: recent) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(recent.name).foregroundStyle(.primary)
                                Text("\(recent.directoryHint) · \(recent.lastOpenedAt.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions { Button(role: .destructive) { store.forget(recent) } label: { Label("移除", systemImage: "trash") } }
                    }
                }
            }
            .navigationTitle("MDTurn")
            .refreshable { store.refreshSync() }
            .onAppear { store.refreshLocalFiles() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { store.refreshLocalFiles() } }
            .navigationDestination(item: $store.current) { document in ReaderView(document: document) }
            .fileImporter(isPresented: $importing, allowedContentTypes: markdownTypes, allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first { store.open(url: url, fromExternal: true) }
            }
            .alert("出错了", isPresented: Binding(get: { store.lastError != nil }, set: { if !$0 { store.lastError = nil } })) {
                Button("好", role: .cancel) {}
            } message: { Text(store.lastError ?? "") }
        }
    }
}

extension OpenedDocument: Hashable {
    static func == (lhs: OpenedDocument, rhs: OpenedDocument) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
