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
            progressBanner
            ReaderWebView(document: document, reloadToken: $reloadToken, contentVersion: document.contentVersion, onEvent: handle, onReady: { bridge = $0 })
                .ignoresSafeArea(edges: .bottom)
            statusBar
        }
        .onChange(of: document.notice) { _, notice in
            guard notice != nil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { if document.notice == notice { document.notice = nil } }
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
                    if let sync = document.sync {
                        Button { store.submitBatch(for: document) } label: { Label("完成本轮:把批注交给 Mac", systemImage: "paperplane") }
                            .disabled(document.openNotes.isEmpty || !document.annotationAllowed)
                        if !document.submittedNotes.isEmpty {
                            Button { store.resubmitBatch(for: document) } label: { Label("重新发送已提交的批次", systemImage: "arrow.clockwise") }
                        }
                        if !sync.summary.isEmpty {
                            Button { message = sync.summary } label: { Label("查看改稿摘要", systemImage: "text.quote") }
                        }
                    } else {
                        Button { store.submitBatch(for: document) } label: { Label("完成本轮:导出批注批次", systemImage: "paperplane") }
                            .disabled(document.openNotes.isEmpty)
                        if !document.submittedNotes.isEmpty {
                            Button { store.resubmitBatch(for: document) } label: { Label("重新导出已提交的批次", systemImage: "arrow.clockwise") }
                        }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
            if document.newerVersionAvailable, let sync = document.sync {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        if let latest = store.synced.first(where: { $0.docId == sync.docId }) { store.loadLatestVersion(latest, into: document) }
                    } label: { Label("新版", systemImage: "arrow.down.doc") }
                    .tint(.orange)
                }
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

    /// 顶部横幅:Mac 那头正在干什么(等待智能体 / 修改中),以及新版刚换进来的一次性提示
    @ViewBuilder private var progressBanner: some View {
        if let notice = document.notice {
            Button {
                if let summary = document.sync?.summary, !summary.isEmpty { message = summary }
                document.notice = nil
            } label: {
                HStack(spacing: 8) { Image(systemName: "checkmark.circle.fill"); Text(notice); Spacer() }
                    .font(.footnote).padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.green.opacity(0.15))
            }
            .buttonStyle(.plain)
        } else if let sync = document.sync, let text = progressText(sync) {
            HStack(spacing: 8) {
                if sync.phoneState == "applying" || sync.phoneState == "manual-editing" { ProgressView().controlSize(.small) } else { Image(systemName: "clock") }
                Text(text); Spacer()
            }
            .font(.footnote).padding(.horizontal, 14).padding(.vertical, 8)
            .background(Color.orange.opacity(0.15))
        }
    }

    private func progressText(_ sync: SyncedDocument) -> String? {
        switch sync.phoneState {
        case "waiting-agent": return "批注已交给 Mac,等待智能体开始改稿"
        case "applying": return "Mac 正在修改,改完会自动换成新版"
        case "manual-editing": return "Mac 上正在手工修改,改完会自动换成新版"
        case "conflict": return "Mac 上原文被改过,等待 Mac 处理"
        default: return nil
        }
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

    /// 底部:左边状态链,右边「完成本轮」——每篇必走、唯一会把东西发出去的动作,不藏进「…」菜单(2026-10-14 用户决定)
    private var statusBar: some View {
        HStack(spacing: 8) {
            Image(systemName: document.openNotes.isEmpty && !document.submittedNotes.isEmpty ? "paperplane" : "lock.open")
            Text(statusText).lineLimit(2)
            Spacer()
            finishButton
        }
        .font(.footnote)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.bar)
    }

    @ViewBuilder private var finishButton: some View {
        let open = document.openNotes.count
        let synced = document.sync != nil
        let canFinish = open > 0 && document.annotationAllowed
        if open == 0 && document.submittedNotes.isEmpty && document.annotationAllowed {
            Text("选中文字 → 菜单「批注」").foregroundStyle(.secondary)
        } else {
            Button { store.submitBatch(for: document) } label: {
                Label(open > 0 ? "完成本轮(\(open) 条)" : (synced ? "完成本轮" : "导出批注"), systemImage: "paperplane.fill")
                    .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(!canFinish)
        }
    }

    /// 跨端规则第 7 节的手机状态链。Mac 推来的文档:本地已保存 → 等待同步 → Mac 已接收 → 等待智能体 → 修改中 → 新版可复核;
    /// 手机独立打开的文件(文件传递)只有"本地已保存"和"已导出,等待 Mac 接收"两档。
    private var statusText: String {
        let open = document.openNotes.count, sent = document.submittedNotes.count
        if let sync = document.sync {
            if document.newerVersionAvailable { return "Mac 已推来新版 · 点左上角「新版」" }
            let received = document.receivedNotes.count, rejected = document.rejectedNotes.count
            if sent > 0 {
                if store.pendingUploads > 0 { return "等待同步 \(sent) 条(联网后自动上传)" }
                let waitedLong = document.submittedNotes.compactMap { $0.raw["submittedAt"] as? String }.compactMap(ISO8601DateFormatter().date(from:)).min()
                    .map { Date().timeIntervalSince($0) > 180 } ?? false
                return waitedLong ? "已提交 \(sent) 条 · 等待 Mac 在线" : "已提交 \(sent) 条 · 等待 Mac 接收"
            }
            if received > 0 && open == 0 { return "Mac 已接收 \(received) 条 · \(sync.stateLabel)" }
            if rejected > 0 && open == 0 { return "\(rejected) 条未被采用 · \(sync.stateLabel)" }
            if sync.canAnnotate && !document.annotationAllowed { return "正文还不是这一轮的,等同步完成后再批注" }
            return sync.canAnnotate ? "\(sync.stateLabel) · 本地已保存 \(open) 条" : sync.stateLabel
        }
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
                        Text("\(document.sync == nil ? "已导出" : "已提交"),等待 Mac 接收 \(document.submittedNotes.count)")
                    } footer: {
                        Text("已提交的批注锁定,不能再改;要补充就写新批注,下一批再交。")
                    }
                }
                if !document.receivedNotes.isEmpty {
                    Section("Mac 已接收 \(document.receivedNotes.count)") {
                        ForEach(document.receivedNotes) { note in
                            NoteRow(note: note)
                                .contentShape(Rectangle())
                                .onTapGesture { if !note.isDocumentScope { onFocus(note.id) } }
                        }
                    }
                }
                if !document.rejectedNotes.isEmpty {
                    Section {
                        ForEach(document.rejectedNotes) { note in
                            VStack(alignment: .leading, spacing: 4) {
                                NoteRow(note: note)
                                Text(note.rejectedReason ?? "未被采用").font(.caption).foregroundStyle(.red)
                            }
                        }
                    } header: {
                        Text("未被采用 \(document.rejectedNotes.count)")
                    } footer: {
                        Text("Mac 没有采用这批批注(原因见每条下方);它们仍保留在手机上,需要时在新一轮重新写。")
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
