import SwiftUI
import UniformTypeIdentifiers

/// 文件库:打开文件、最近文件、示例文档。打开后进入 ReaderView。
struct LibraryView: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var importing = false

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
