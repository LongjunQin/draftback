import SwiftUI
import UIKit

/// 阅读与批注界面:顶部状态、正文(WebView)、底部批注计数;大纲、批注列表、写批注、分享均为 sheet。
struct ReaderView: View {
    @EnvironmentObject private var store: DocumentStore
    @ObservedObject var document: OpenedDocument

    @State private var bridge: ReaderBridge?
    @State private var reloadToken = 0
    @State private var showOutline = false
    @State private var showNotes = false
    @State private var composer: Composer?
    @State private var shareItem: URL?
    @State private var exportingPDF = false
    @State private var message: String?

    struct Composer: Identifiable {
        let id = UUID()
        var anchor: [String: Any]?
        var quote: String
        var scope: String?
        var editingNoteId: String?
        var initialComment: String
    }

    var body: some View {
        VStack(spacing: 0) {
            ReaderWebView(document: document, reloadToken: $reloadToken, onEvent: handle, onReady: { bridge = $0 })
                .ignoresSafeArea(edges: .bottom)
            statusBar
        }
        .navigationTitle(document.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showOutline = true } label: { Image(systemName: "list.bullet.indent") }
                    .disabled(document.outline.isEmpty)
                Button { showNotes = true } label: {
                    Label("批注", systemImage: "text.bubble")
                        .labelStyle(.iconOnly)
                        .overlay(alignment: .topTrailing) { badge }
                }
                Menu {
                    Button { composer = Composer(anchor: nil, quote: "", scope: "document", editingNoteId: nil, initialComment: "") } label: {
                        Label("写总体意见", systemImage: "text.badge.plus")
                    }
                    Button { exportPDF() } label: { Label("导出 PDF", systemImage: "doc.richtext") }
                    Button { store.submitBatch(for: document) } label: { Label("完成本轮:导出批注批次", systemImage: "paperplane") }
                        .disabled(document.openNotes.isEmpty)
                    if !document.submittedNotes.isEmpty {
                        Button { store.resubmitBatch(for: document) } label: { Label("重新导出已提交的批次", systemImage: "arrow.clockwise") }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $showOutline) { OutlineSheet(items: document.outline) { id in bridge?.scrollToHeading(id); showOutline = false } }
        .sheet(isPresented: $showNotes) {
            NotesSheet(document: document, onFocus: { id in bridge?.focus(noteId: id); showNotes = false },
                       onEdit: { note in composer = Composer(anchor: nil, quote: note.quote, scope: nil, editingNoteId: note.id, initialComment: note.comment) },
                       onDelete: { note in store.remove(noteId: note.id, from: document); reloadToken += 1 })
        }
        .sheet(item: $composer) { item in
            ComposerSheet(quote: item.quote, initial: item.initialComment, isDocumentScope: item.scope == "document") { comment in
                if let editing = item.editingNoteId {
                    store.update(noteId: editing, comment: comment, in: document)
                } else {
                    store.add(note: Note.make(anchor: item.anchor, quote: item.quote, comment: comment, scope: item.scope), to: document)
                }
                reloadToken += 1
                bridge?.clearSelection()
            }
        }
        .onChange(of: store.pendingShare) { _, url in
            if let url { shareItem = url; store.pendingShare = nil }
        }
        .sheet(item: $shareItem) { url in ShareSheet(items: [url]) }
        .alert("提示", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("好", role: .cancel) {}
        } message: { Text(message ?? "") }
        .overlay { if exportingPDF { ProgressView("正在生成 PDF…").padding().background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12)) } }
        #if DEBUG
        // 仅调试版:模拟器自动化验证用(--export-batch 导出、--resubmit-batch 重发、--show-notes 打开批注列表)
        .onAppear {
            let args = CommandLine.arguments
            if args.contains("--export-batch") { store.submitBatch(for: document) }
            if args.contains("--resubmit-batch") { store.resubmitBatch(for: document) }
            if args.contains("--show-notes") { showNotes = true }
        }
        #endif
    }

    private var badge: some View {
        Group {
            if !document.openNotes.isEmpty {
                Text("\(document.openNotes.count)")
                    .font(.caption2.bold()).foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(.orange))
                    .offset(x: 10, y: -8)
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            Image(systemName: document.openNotes.isEmpty && !document.submittedNotes.isEmpty ? "paperplane" : "lock.open")
            Text(statusText)
            Spacer()
            Text("选中文字 → 菜单「批注」").foregroundStyle(.secondary)
        }
        .font(.footnote)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.bar)
    }

    /// 跨端规则第 7 节的手机状态链,文件传递阶段只有"本地已保存"和"已导出,等待 Mac 接收"两档。
    private var statusText: String {
        let open = document.openNotes.count, sent = document.submittedNotes.count
        if sent > 0 && open == 0 { return "已导出 \(sent) 条 · 等待 Mac 接收" }
        if sent > 0 { return "本地已保存 \(open) 条 · 已导出 \(sent) 条" }
        return "手机批注 · 本地已保存 \(open) 条"
    }

    private func handle(_ event: ReaderEvent) {
        switch event {
        case .ready: break
        case .rendered(let outline): document.outline = outline
        case .selection(let anchor, let quote):
            composer = Composer(anchor: anchor, quote: quote, scope: nil, editingNoteId: nil, initialComment: "")
        case .noSelection: message = "没有识别到有效的文字选区,请重新选择。"
        case .error(let text): message = text
        }
    }

    private func exportPDF() {
        guard let bridge else { return }
        exportingPDF = true
        bridge.createPDF { result in
            DispatchQueue.main.async {
                exportingPDF = false
                switch result {
                case .success(let data): store.sharePDF(data, name: document.name)
                case .failure(let error): message = "导出 PDF 失败:\(error.localizedDescription)"
                }
            }
        }
    }
}

struct OutlineSheet: View {
    let items: [OutlineItem]
    let onSelect: (String) -> Void
    var body: some View {
        NavigationStack {
            List(items) { item in
                Button { onSelect(item.id) } label: {
                    Text(item.text)
                        .font(item.level == 1 ? .headline : .body)
                        .padding(.leading, CGFloat(max(0, item.level - 1)) * 16)
                }
                .foregroundStyle(.primary)
            }
            .navigationTitle("大纲")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}

struct NotesSheet: View {
    @ObservedObject var document: OpenedDocument
    let onFocus: (String) -> Void
    let onEdit: (Note) -> Void
    let onDelete: (Note) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("本轮未提交 \(document.openNotes.count)") {
                    if document.openNotes.isEmpty {
                        Text("还没有批注。选中正文文字,在弹出的菜单里点「批注」。").foregroundStyle(.secondary)
                    }
                    ForEach(document.openNotes) { note in
                        NoteRow(note: note)
                            .contentShape(Rectangle())
                            .onTapGesture { if !note.isDocumentScope { onFocus(note.id) } }
                            .swipeActions {
                                Button(role: .destructive) { onDelete(note) } label: { Label("删除", systemImage: "trash") }
                                Button { onEdit(note) } label: { Label("修改", systemImage: "pencil") }.tint(.accentColor)
                            }
                    }
                }
                if !document.submittedNotes.isEmpty {
                    Section {
                        ForEach(document.submittedNotes) { note in
                            NoteRow(note: note)
                                .contentShape(Rectangle())
                                .onTapGesture { if !note.isDocumentScope { onFocus(note.id) } }
                        }
                    } header: {
                        Text("已导出,等待 Mac 接收 \(document.submittedNotes.count)")
                    } footer: {
                        Text("已导出的批注锁定,不能再改;要补充就写新批注,下一批再交。")
                    }
                }
                let older = document.olderVersionNotes
                if !older.isEmpty {
                    Section {
                        ForEach(older) { note in
                            VStack(alignment: .leading, spacing: 4) {
                                NoteRow(note: note)
                                Text(note.isSubmitted ? "已导出" : (note.isOpen ? "未提交" : note.status))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } header: {
                        Text("旧版本上的批注 \(older.count)")
                    } footer: {
                        Text("文档已换成新版本,这些批注写在旧版本上,只读保留,不会再导出。")
                    }
                }
            }
            .navigationTitle("批注")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}

struct NoteRow: View {
    let note: Note
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if note.isDocumentScope {
                Text("总体意见").font(.caption.bold()).foregroundStyle(.orange)
            } else if !note.quote.isEmpty {
                Text(note.quote).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            Text(note.comment)
        }
    }
}

struct ComposerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let quote: String
    let initial: String
    let isDocumentScope: Bool
    let onSave: (String) -> Void
    @State private var text: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if isDocumentScope {
                    Text("针对全篇的意见,不锚定文字").font(.footnote).foregroundStyle(.secondary)
                } else if !quote.isEmpty {
                    Text(quote).font(.footnote).foregroundStyle(.secondary).lineLimit(4)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
                TextEditor(text: $text)
                    .focused($focused)
                    .frame(minHeight: 140)
                    .padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.3)))
                Spacer()
            }
            .padding()
            .navigationTitle(initial.isEmpty ? "写批注" : "修改批注")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { onSave(text.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { text = initial; focused = true }
        }
        .presentationDetents([.medium, .large])
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

extension URL: @retroactive Identifiable { public var id: String { absoluteString } }
