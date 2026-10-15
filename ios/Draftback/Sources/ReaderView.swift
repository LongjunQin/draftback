import SwiftUI
import UIKit

/// 读稿页(UI 方案第 4.2–4.4 节):导航栏标题下一行是状态;正文上方按情况出现横幅;
/// 底栏左槽是状态两行,选中文字时变成琥珀描边的「批注这段」;右槽是主按钮「交给 AI · k」。
/// 状态全部由 ReaderStatus 按真实事件算出(跨端规则第 7 节),这里只负责画和转发动作。
struct ReaderView: View {
    @EnvironmentObject private var store: DocumentStore
    @ObservedObject var document: OpenedDocument
    /// 字号:0 默认 / 1 大 / 2 特大,在系统动态字体之上再加一档
    @AppStorage("draftback.reader.fontStep") private var fontStep = 0
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var bridge: ReaderBridge?
    @State private var reloadToken = 0
    @State private var showOutline = false
    @State private var showNotes = false
    @State private var composer: Composer?
    @State private var shareItem: URL?
    @State private var exportingPDF = false
    @State private var message: String?
    @State private var hasSelection = false
    /// 回稿卡「显示改动」开着:对比是只读视图,这时不能批注
    @State private var showingChanges = false
    @State private var showResults = false
    @State private var confirmFinalize: ReaderStatus.Primary?
    /// 弹确认框时那一轮的身份与指纹(确认前 Mac 推来新一轮就作废)
    @State private var finalizeTarget: (reviewId: String, hash: String)?
    @State private var confirmNewVersion = false
    @State private var handOffCount = 0
    @State private var clock = Date()

    struct Composer: Identifiable {
        let id = UUID()
        var anchor: [String: Any]?
        var quote: String
        var scope: String?
        var editingNoteId: String?
        var initialComment: String
    }

    private var status: ReaderStatus {
        let submitted = document.submittedNotes
        let latest = document.sync.flatMap { sync in store.synced.first { $0.docId == sync.docId } }
        let formatter = ISO8601DateFormatter()
        return ReaderStatus.make(.init(
            sync: document.sync,
            annotationAllowed: document.annotationAllowed,
            newerVersionAvailable: document.newerVersionAvailable,
            latestRound: latest?.round,
            open: document.openNotes.count, submitted: submitted.count,
            received: document.receivedNotes.count, rejected: document.rejectedNotes.count,
            pendingUploads: store.pendingUploads,
            oldestSubmittedAt: submitted.compactMap { $0.raw["submittedAt"] as? String }.compactMap(formatter.date(from:)).min(),
            now: clock,
            supportsIntents: document.sync?.supportsIntents ?? false,
            macOpenCount: document.sync?.openCount ?? 0,
            finalize: finalizeState,
            nextRoundInFlight: document.nextRoundInFlight.count))
    }

    private var finalizeState: ReaderStatus.FinalizeState? {
        guard let docId = document.sync?.docId, let request = store.finalizeRequests[docId] else { return nil }
        if let reason = request.rejectedReason { return .rejected(reason) }
        return .pending
    }

    private var fontScale: Double {
        _ = dynamicTypeSize // 跟随系统动态字体:尺寸一变就重算
        let base = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17) / 17
        return base * [1.0, 1.15, 1.3][min(max(fontStep, 0), 2)]
    }

    var body: some View {
        let status = self.status
        VStack(spacing: 0) {
            if store.isOffline { offlineLine }
            if let notice = document.notice { noticeBanner(notice) } else if let banner = status.banner { bannerView(banner) }
            ReaderWebView(document: document, reloadToken: $reloadToken, contentVersion: document.contentVersion,
                          fontScale: fontScale, annotationEnabled: status.canAnnotate && !showingChanges, cardKey: document.cardKey,
                          onEvent: { handle($0, status: status) }, onReady: { bridge = $0 })
            bottomBar(status)
        }
        .onChange(of: document.notice) { _, notice in
            guard notice != nil else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { if document.notice == notice { document.notice = nil } }
        }
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { clock = $0 }
        // 正文或回稿卡重画后网页回到干净稿
        .onChange(of: document.contentVersion) { _, _ in showingChanges = false }
        // 回执改了批注的状态或归属(比如新一轮快照先到、回执后到):正文高亮跟着重画
        .onChange(of: document.notes) { _, _ in reloadToken += 1 }
        .onChange(of: document.cardKey) { _, _ in showingChanges = false }
        .navigationTitle(document.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(document.name).font(.headline).lineLimit(1)
                    Text(status.subtitle).font(.caption.weight(.semibold)).foregroundStyle(status.subtitleTone.text).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showOutline = true } label: { Image(systemName: "list.bullet.indent") }
                    .disabled(document.outline.isEmpty)
                    .accessibilityLabel("大纲")
                Button { showNotes = true } label: {
                    Image(systemName: "text.bubble").overlay(alignment: .topTrailing) { badge }
                }
                .accessibilityLabel(document.roundNotesCount > 0 ? "批注,本轮 \(document.roundNotesCount) 条" : "批注")
                moreMenu(status)
            }
        }
        .sheet(isPresented: $showOutline) { OutlineSheet(items: document.outline) { id in bridge?.scrollToHeading(id); showOutline = false } }
        .sheet(isPresented: $showResults) {
            if let results = document.sync?.results {
                ResultsSheet(round: document.sync?.round ?? 0, results: results) { item in
                    showResults = false
                    if item.scope != "document", !item.quote.isEmpty {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { bridge?.locateQuote(item.quote) }
                    }
                }
            }
        }
        .sheet(isPresented: $showNotes) {
            NotesSheet(document: document, canAnnotate: status.canAnnotate,
                       onCopy: { note in copyToRound(note) },
                       onFocus: { id in bridge?.focus(noteId: id); showNotes = false },
                       onEdit: { note in composer = Composer(anchor: nil, quote: note.quote, scope: note.isDocumentScope ? "document" : nil, editingNoteId: note.id, initialComment: note.comment) },
                       onDelete: { note in store.remove(noteId: note.id, from: document); reloadToken += 1 })
        }
        .sheet(item: $composer) { item in
            ComposerSheet(quote: item.quote, initial: item.initialComment, isDocumentScope: item.scope == "document") { comment in
                // 存进手机才关输入框;没存进去(会有提示)就留着,字不丢
                let saved: Bool
                if let editing = item.editingNoteId {
                    saved = store.update(noteId: editing, comment: comment, in: document)
                } else {
                    saved = store.add(note: Note.make(anchor: item.anchor, quote: item.quote, comment: comment, scope: item.scope), to: document)
                }
                guard saved else { return false }
                reloadToken += 1
                bridge?.clearSelection()
                return true
            }
        }
        .confirmationDialog(confirmFinalize == .approve ? "通过并定稿?" : "定稿?", isPresented: Binding(get: { confirmFinalize != nil }, set: { if !$0 { confirmFinalize = nil } }),
                            titleVisibility: .visible) {
            Button(confirmFinalize == .approve ? "通过 · 定稿" : "定稿") {
                if let target = finalizeTarget { store.requestFinalize(for: document, expected: target) }
                confirmFinalize = nil
            }
            Button("取消", role: .cancel) { confirmFinalize = nil }
        } message: {
            Text(confirmFinalize == .approve
                 ? "全文没有任何批注:记为通过并定稿,AI 会收到「审阅结束」。想让 AI 再改,先写一条批注再交出。"
                 : "这版就是终稿,AI 会收到「审阅结束」。以后再批注,会开始新的一轮。")
        }
        .confirmationDialog("换成新版?", isPresented: $confirmNewVersion, titleVisibility: .visible) {
            Button("换成新版") { loadNewVersion() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("手头 \(document.openNotes.count) 条没交的批注会留在旧版上,不会再交出。")
        }
        .onChange(of: store.pendingShare) { _, url in
            if let url { shareItem = url; store.pendingShare = nil }
        }
        .sheet(item: $shareItem) { url in ShareSheet(items: [url]) }
        .alert(message != nil ? "提示" : "出错了", isPresented: Binding(get: { message != nil || store.lastError != nil },
                                                                        set: { if !$0 { message = nil; store.lastError = nil } })) {
            Button("好", role: .cancel) {}
        } message: { Text(message ?? store.lastError ?? "") }
        .overlay { if exportingPDF { ProgressView("正在生成 PDF…").padding().background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12)) } }
        .sensoryFeedback(.success, trigger: handOffCount)
        #if DEBUG
        // 仅调试版:模拟器自动化验证用(--export-batch 导出、--resubmit-batch 重发、--show-notes 打开批注列表、--demo-select 选中一段、--demo-annotate 再点「批注这段」、--demo-changes 点「显示改动」)
        .onAppear {
            let args = CommandLine.arguments
            if args.contains("--export-batch") { store.submitBatch(for: document) }
            if args.contains("--resubmit-batch") { store.resubmitBatch(for: document) }
            if args.contains("--show-notes") { showNotes = true }
            if args.contains("--demo-select") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { bridge?.debugSelectParagraph(2) } }
            if args.contains("--demo-annotate") { DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { bridge?.requestAnnotation() } }
            if args.contains("--demo-changes") { DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { bridge?.toggleChanges() } }
            if let index = args.firstIndex(of: "--demo-locate"), index + 1 < args.count {
                let quote = args[index + 1]
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { bridge?.locateQuote(quote) }
            }
            if args.contains("--demo-outline") { DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { if let last = document.outline.last { bridge?.scrollToHeading(last.id) } } }
            if args.contains("--demo-results") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { showResults = document.sync?.results != nil } }
        }
        #endif
    }

    // MARK: 顶部:离线线、横幅

    private var offlineLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "wifi.slash")
            Text("离线 · 批注会先存在手机里")
        }
        .font(.caption).foregroundStyle(.secondary)
        .frame(maxWidth: .infinity).padding(.vertical, 5)
        .background(Color(uiColor: .secondarySystemBackground))
        .accessibilityElement(children: .combine)
    }

    private func bannerView(_ banner: ReaderStatus.Banner) -> some View {
        HStack(spacing: 8) {
            if banner.spinning && !reduceMotion {
                ProgressView().controlSize(.small).tint(banner.tone.color)
            } else {
                Image(systemName: icon(for: banner.tone))
            }
            Text(banner.text).lineLimit(2)
            Spacer(minLength: 4)
            if banner.action == .loadNewVersion {
                Button("换成新版") { requestNewVersion() }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered).controlSize(.small).tint(banner.tone.color)
            }
        }
        .font(.footnote)
        .foregroundStyle(banner.tone.text)
        .padding(.horizontal, 14).frame(minHeight: 40)
        .background(banner.tone.soft)
        .accessibilityElement(children: .contain)
    }

    /// 新版刚换进来的一次性提示(第 2 步换成常驻的回稿卡)
    private func noticeBanner(_ notice: String) -> some View {
        Button {
            if let summary = document.sync?.summary, !summary.isEmpty { message = summary }
            document.notice = nil
        } label: {
            HStack(spacing: 8) { Image(systemName: "checkmark.circle.fill"); Text(notice).lineLimit(2); Spacer() }
                .font(.footnote).foregroundStyle(Tone.back.text)
                .padding(.horizontal, 14).frame(minHeight: 40)
                .background(Tone.back.soft)
        }
        .buttonStyle(.plain)
    }

    private func icon(for tone: Tone) -> String {
        switch tone {
        case .waiting: return "clock"
        case .ai: return "sparkles"
        case .conflict: return "exclamationmark.triangle.fill"
        case .back, .done: return "checkmark.circle"
        case .turn: return "arrow.down.doc"
        case .idle: return "info.circle"
        }
    }

    // MARK: 导航栏:批注徽标与「…」

    private var badge: some View {
        Group {
            let count = document.roundNotesCount
            if count > 0 {
                Text("\(count)")
                    .font(.caption2.bold()).foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Palette.amber))
                    .offset(x: 10, y: -8)
            }
        }
    }

    private func moreMenu(_ status: ReaderStatus) -> some View {
        Menu {
            if status.canAnnotate {
                Button { composer = Composer(anchor: nil, quote: "", scope: "document", editingNoteId: nil, initialComment: "") } label: {
                    Label("写总体意见", systemImage: "text.badge.plus")
                }
            }
            if document.returnCard != nil {
                Button { bridge?.scrollToTop() } label: { Label("回稿卡", systemImage: "arrow.uturn.backward.circle") }
            }
            if document.returnCard != nil, let results = document.sync?.results, !results.items.isEmpty {
                Button { showResults = true } label: { Label("逐条结果", systemImage: "checklist") }
            }
            if document.changesBase != nil {
                Button { bridge?.toggleChanges() } label: {
                    Label(showingChanges ? "隐藏改动" : "显示改动", systemImage: showingChanges ? "eye.slash" : "arrow.left.arrow.right")
                }
            }
            if !document.submittedNotes.isEmpty {
                Button { store.resubmitBatch(for: document) } label: {
                    Label(document.sync == nil ? "重新导出" : "重新发送", systemImage: "arrow.clockwise")
                }
            }
            Button { exportPDF() } label: { Label("导出 PDF", systemImage: "doc.richtext") }
            Picker(selection: $fontStep) {
                Text("默认").tag(0)
                Text("大").tag(1)
                Text("特大").tag(2)
            } label: { Label("字号", systemImage: "textformat.size") }
            .pickerStyle(.menu)
        } label: { Image(systemName: "ellipsis.circle") }
        .accessibilityLabel("更多")
    }

    // MARK: 底栏:左槽状态 / 批注这段,右槽主按钮

    private func bottomBar(_ status: ReaderStatus) -> some View {
        HStack(spacing: 10) {
            if hasSelection && status.canAnnotate && !showingChanges {
                Button { bridge?.requestAnnotation() } label: {
                    Label("批注这段", systemImage: "text.bubble")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 46)
                }
                .buttonStyle(AnnotateButtonStyle())
                .transition(.opacity)
            } else {
                statusSlot(status)
            }
            if let primary = status.primary { primaryButton(primary) }
        }
        .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 6)
        .background(.bar)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: hasSelection)
    }

    private func statusSlot(_ status: ReaderStatus) -> some View {
        Button {
            if status.statusTap == .openNotes { showNotes = true }
            if status.statusTap == .dismissFinalize, let docId = document.sync?.docId { store.dismissFinalizeRejection(docId: docId) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(status.statusLine).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                if let detail = status.statusDetail {
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(status.statusTap != nil)
        .accessibilityHint(status.statusTap == .openNotes ? "打开批注列表" : status.statusTap == .dismissFinalize ? "收起这条说明" : "")
    }

    private func primaryButton(_ primary: ReaderStatus.Primary) -> some View {
        let (label, enabled) = primaryLabel(primary)
        return Button { perform(primary) } label: {
            Text(label).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                .frame(minWidth: 120, minHeight: 46)
                .padding(.horizontal, 14)
        }
        .buttonStyle(PrimaryButtonStyle(enabled: enabled))
        .disabled(!enabled)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func primaryLabel(_ primary: ReaderStatus.Primary) -> (String, Bool) {
        switch primary {
        case .handOff(let count): return ("交给 AI · \(count)", true)
        case .handOffDisabled: return ("交给 AI", false)
        case .handedOff: return ("已交出", false)
        case .busy: return ("改稿中…", false)
        case .finalize: return ("定稿", true)
        case .approve: return ("通过 · 定稿", true)
        case .resend: return ("重新发送", true)
        case .exportBatch(let count): return ("导出批注 · \(count)", true)
        case .reexport: return ("重新导出", true)
        }
    }

    private func perform(_ primary: ReaderStatus.Primary) {
        switch primary {
        case .handOff, .exportBatch:
            store.submitBatch(for: document)
            handOffCount += 1
        case .resend, .reexport:
            store.resubmitBatch(for: document)
        case .finalize, .approve:
            if let reviewId = document.sync?.reviewId { finalizeTarget = (reviewId, document.hash) }
            confirmFinalize = primary
        case .handOffDisabled, .handedOff, .busy:
            break
        }
    }

    // MARK: 动作

    private func requestNewVersion() {
        if document.openNotes.isEmpty { loadNewVersion() } else { confirmNewVersion = true }
    }

    private func loadNewVersion() {
        guard let sync = document.sync, let latest = store.synced.first(where: { $0.docId == sync.docId }) else { return }
        store.loadLatestVersion(latest, into: document)
    }

    private func handle(_ event: ReaderEvent, status: ReaderStatus) {
        switch event {
        case .ready: break
        case .rendered(let outline): document.outline = outline
        case .selectionState(let active): hasSelection = active
        case .changesState(let showing): showingChanges = showing
        case .showResults: if document.sync?.results != nil { showResults = true }
        case .locateFailed: message = "正文里找不到这句了,可能已经改掉。点「显示改动」看改了什么。"
        case .selection(let anchor, let quote):
            guard status.canAnnotate else { message = status.blockedReason ?? "现在不能批注。"; return }
            guard !showingChanges else { message = "对比是只读的。先点「隐藏改动」回到正文再批注。"; return }
            composer = Composer(anchor: anchor, quote: quote, scope: nil, editingNoteId: nil, initialComment: "")
        case .noSelection: message = "没有识别到有效的文字选区,请重新选择。"
        case .error(let text): message = text
        }
    }

    /// 复制到本轮:引文在本轮正文里还在就重新算锚点,找不到就复制成总体意见(带原引文)
    private func copyToRound(_ note: Note) {
        let finish: ([String: Any]?) -> Void = { anchor in
            if store.copyToRound(note, anchor: anchor, in: document) {
                reloadToken += 1
                message = anchor == nil && !note.isDocumentScope && !note.quote.isEmpty ? "本轮正文里找不到原来那句,已复制成总体意见,带上了原引文。" : nil
            }
        }
        if note.isDocumentScope || note.quote.isEmpty { finish(nil); return }
        guard let bridge else { finish(nil); return }
        bridge.anchorForQuote(note.quote, headingPath: note.headingPath) { anchor in DispatchQueue.main.async { finish(anchor) } }
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

/// 右槽主按钮:青绿实底;不能点时灰底
struct PrimaryButtonStyle: ButtonStyle {
    let enabled: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(enabled ? Color.white : Color.secondary)
            .background(RoundedRectangle(cornerRadius: 12).fill(enabled ? Tone.turn.color : Color(uiColor: .tertiarySystemFill)))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// 「批注这段」:琥珀描边(琥珀只给批注)
struct AnnotateButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Palette.amberText)
            .background(RoundedRectangle(cornerRadius: 12).fill(Palette.amberSoft))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.amber, lineWidth: 1.5))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

/// 逐条结果(UI 方案 4.4;跨端规则 v2.4):你说了什么、AI 怎么处理;点一条回到正文找到那句
struct ResultsSheet: View {
    let round: Int
    let results: RoundResults
    let onSelect: (RoundResults.Item) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(results.items) { item in
                        Button { onSelect(item) } label: { row(item) }
                            .buttonStyle(.plain)
                    }
                } header: {
                    Text("采纳 \(results.applied) · 未采纳 \(results.wontfix)")
                } footer: {
                    if results.truncated == true || results.items.count < results.total { Text("只带过来前 \(results.items.count) 条,其余在 Mac 上看。") }
                }
            }
            .navigationTitle("第 \(round) 轮 · 逐条结果")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ item: RoundResults.Item) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.status == "applied" ? "checkmark.circle.fill" : item.status == "wontfix" ? "xmark.circle" : "circle")
                .foregroundStyle(item.status == "applied" ? Tone.back.color : Tone.idle.color)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 6) {
                if item.scope == "document" {
                    Text("总体意见").font(.caption.bold()).foregroundStyle(Palette.amberText)
                } else if !item.quote.isEmpty {
                    Text("“\(item.quote)”").font(.caption).foregroundStyle(Color.secondary).lineLimit(3)
                }
                (Text("你 ").bold() + Text(item.you)).font(.subheadline).foregroundStyle(Color.primary)
                (Text("AI ").bold() + Text(item.ai)).font(.subheadline).foregroundStyle(Tone.back.text)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
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

/// 批注列表:未交(可改可删)/ 已交出 · 等待 Mac 收到 / Mac 已收到 / 被 Mac 拒收(附原因)/ 旧版本上的批注(只读)
struct NotesSheet: View {
    @ObservedObject var document: OpenedDocument
    let canAnnotate: Bool
    /// 复制到本轮(被拒收的、旧版本上的)
    let onCopy: (Note) -> Void
    let onFocus: (String) -> Void
    let onEdit: (Note) -> Void
    let onDelete: (Note) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if document.openNotes.isEmpty {
                        Text(canAnnotate ? "还没有批注。选中正文文字就能批注。" : "没有未交的批注。").foregroundStyle(.secondary)
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
                } header: {
                    Text("未交 \(document.openNotes.count)")
                } footer: {
                    if !canAnnotate && !document.openNotes.isEmpty {
                        Text("这一轮已经交出或结束,这些没交的批注不会进这一轮。")
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
                        Text(document.sync == nil ? "已导出 · 等待 Mac 导入 \(document.submittedNotes.count)" : "已交出 · 等待 Mac 收到 \(document.submittedNotes.count)")
                    } footer: {
                        Text("交出的批注锁定,不能再改。")
                    }
                }
                if !document.receivedNotes.isEmpty {
                    Section("Mac 已收到 \(document.receivedNotes.count)") {
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
                                Text(note.rejectedReason ?? "Mac 没有收下").font(.caption).foregroundStyle(Tone.conflict.text)
                            }
                            .swipeActions { if canAnnotate { copyButton(note) } }
                        }
                    } header: {
                        Text("被 Mac 拒收 \(document.rejectedNotes.count)")
                    } footer: {
                        Text("这些批注留在手机上,不会丢。原因见每条下方。")
                    }
                }
                let older = document.olderVersionNotes
                if !older.isEmpty {
                    Section {
                        ForEach(older) { note in
                            VStack(alignment: .leading, spacing: 4) {
                                NoteRow(note: note)
                                Text(olderLabel(note)).font(.caption).foregroundStyle(.secondary)
                            }
                            .swipeActions { if canAnnotate && (note.isOpen || note.isRejected) { copyButton(note) } }
                        }
                    } header: {
                        Text("旧版本上的批注 \(older.count)")
                    } footer: {
                        Text(canAnnotate ? "这些批注写在旧版上,只读保留。左滑「复制到本轮」可以在这一轮再交一次。" : "正文已换成新版。这些批注写在旧版上,只读保留,不会再交出。")
                    }
                }
            }
            .navigationTitle("批注")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }

    private func copyButton(_ note: Note) -> some View {
        Button { onCopy(note) } label: { Label("复制到本轮", systemImage: "doc.on.doc") }.tint(Tone.turn.color)
    }

    private func olderLabel(_ note: Note) -> String {
        if note.isOpen { return "没交" }
        if note.isSubmitted { return document.sync == nil ? "已导出" : "已交出" }
        if note.isReceived { return "Mac 已收到" }
        if note.isRejected { return "被 Mac 拒收" }
        return note.status
    }
}

struct NoteRow: View {
    let note: Note
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if note.isDocumentScope {
                Text("总体意见").font(.caption.bold()).foregroundStyle(Palette.amberText)
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
    /// 返回是否已存进手机;没存进去就不关
    let onSave: (String) -> Bool
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
                        .background(Palette.amberSoft, in: RoundedRectangle(cornerRadius: 8))
                }
                TextEditor(text: $text)
                    .focused($focused)
                    .frame(minHeight: 140)
                    .padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.3)))
                Spacer()
            }
            .padding()
            .navigationTitle(isDocumentScope ? (initial.isEmpty ? "写总体意见" : "修改总体意见") : (initial.isEmpty ? "写批注" : "修改批注"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { if onSave(text.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() } }
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
