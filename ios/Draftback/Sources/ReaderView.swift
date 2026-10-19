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
    @Environment(\.dismiss) private var dismiss
    @Environment(\.cover) private var cover
    @Environment(\.colorScheme) private var scheme

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
    /// 往下读时收起上下栏(网页滚动报上来);选着字、正在确认定稿时照样露出底栏
    @State private var scrollHidden = false
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

    /// 上下栏收起(2026-10-15 用户提:上下栏占的版面太多,正文被压缩)。往下读时收起,往回翻、点正文、到顶或到底时放出来。
    /// 选字时只放出底栏(「批注这段」):顶栏一出来正文会往下挪,选区就跑了
    private var topHidden: Bool { scrollHidden && confirmFinalize == nil }
    private var bottomHidden: Bool { scrollHidden && !hasSelection && confirmFinalize == nil }

    var body: some View {
        let status = self.status
        VStack(spacing: 0) {
            if !topHidden {
                // 方案 C:皮面上栏(返回、文件名与指示灯、大纲、批注、更多),下面按情况一条纸条横幅
                VStack(spacing: 0) {
                    topBar(status).zIndex(2)
                    if store.isOffline { offlineLine }
                    if let notice = document.notice { noticeBanner(notice) } else if let banner = status.banner { bannerView(banner) }
                }
                .zIndex(2)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            // 正文铺满到屏幕上下边缘(2026-10-15 用户提:上下栏收起后上下各有一条黑边、字显示不全)。
            // 滚动视图按安全区自动留白:末行静止时在底部横条上面,滑动时文字可以一直到屏幕边缘
            ReaderWebView(document: document, reloadToken: $reloadToken, contentVersion: document.contentVersion,
                          fontScale: fontScale, annotationEnabled: status.canAnnotate && !showingChanges, cardKey: document.cardKey,
                          onEvent: { handle($0, status: status) }, onReady: { bridge = $0 })
                // 顶栏在时从顶栏下面开始(不让回稿卡、首行钻到顶栏底下);顶栏收起时连状态栏那块一起铺满。底部一直铺到屏幕边缘
                .ignoresSafeArea(.container, edges: topHidden ? [.top, .bottom] : [.bottom])
            if !bottomHidden {
                bottomBar(status).zIndex(2).transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background(Palette.paper.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .statusBarHidden(topHidden) // 读的时候连状态栏一起收起(像「图书」),整屏都是纸面
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: topHidden)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: bottomHidden)
        // 定稿确认期间 Mac 推来了新的一轮:这次确认作废(确认按钮本身也会核对轮次)
        .onChange(of: document.sync?.reviewId) { _, _ in confirmFinalize = nil }
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
        // 仅调试版:模拟器自动化验证用(--export-batch 导出、--resubmit-batch 重发、--show-notes 打开批注列表、--demo-select 选中一段、--demo-annotate 再点「批注这段」、--demo-changes 点「显示改动」、
        // --demo-bars-hidden 收起上下栏、--demo-confirm-finalize 点「定稿」进入底栏确认)
        .onAppear { runDebugArguments() }
        #endif
    }

    #if DEBUG
    private func runDebugArguments() {
        let args = CommandLine.arguments
        if args.contains("--export-batch") { store.submitBatch(for: document) }
        if args.contains("--resubmit-batch") { store.resubmitBatch(for: document) }
        if args.contains("--show-notes") { showNotes = true }
        if args.contains("--demo-outline-sheet") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { showOutline = true } }
        if args.contains("--demo-compose") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { composer = Composer(anchor: nil, quote: "Mac 收到后回一张回执。", scope: nil, editingNoteId: nil, initialComment: "回执是什么?说清楚是谁回给谁") } }
        if args.contains("--demo-select") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { bridge?.debugSelectParagraph(2) } }
        if args.contains("--demo-annotate") { DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { bridge?.requestAnnotation() } }
        if args.contains("--demo-changes") { DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { bridge?.toggleChanges() } }
        if let index = args.firstIndex(of: "--demo-locate"), index + 1 < args.count {
            let quote = args[index + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { bridge?.locateQuote(quote) }
        }
        if args.contains("--demo-outline") { DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { if let last = document.outline.last { bridge?.scrollToHeading(last.id) } } }
        if args.contains("--demo-results") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { showResults = document.sync?.results != nil } }
        if args.contains("--demo-bars-hidden") { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { scrollHidden = true } }
        if args.contains("--demo-confirm-finalize") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if let primary = status.primary, primary == .finalize || primary == .approve { perform(primary) } }
        }
    }
    #endif

    // MARK: 顶部:离线线、横幅

    private var offlineLine: some View {
        HStack(spacing: 8) {
            IndicatorLight(light: .off)
            Text("离线 · 批注会先存在手机里")
        }
        .font(.footnote).foregroundStyle(Skin.ink2)
        .frame(maxWidth: .infinity).frame(minHeight: 32)
        .background(PaperSurface(color: Tone.idle.soft))
        .overlay(alignment: .bottom) { Rectangle().fill(Skin.rule).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }

    /// 上栏下面一条纸条:左边一盏指示灯(AI 在改时黄灯闪),说明这会儿的情况
    private func bannerView(_ banner: ReaderStatus.Banner) -> some View {
        HStack(spacing: 9) {
            IndicatorLight(light: banner.tone.light, blinking: banner.spinning)
            Text(banner.text).lineLimit(2).foregroundStyle(banner.tone.text)
            Spacer(minLength: 4)
            if banner.action == .loadNewVersion {
                Button { requestNewVersion() } label: {
                    Text("换成新版").font(.footnote.weight(.semibold)).padding(.horizontal, 12).frame(minHeight: 30)
                }
                .buttonStyle(RaisedButtonStyle())
            }
        }
        .font(.footnote)
        .padding(.horizontal, 14).frame(minHeight: 42)
        .background(PaperSurface(color: banner.tone.soft))
        .overlay(alignment: .bottom) { Rectangle().fill(Skin.rule).frame(height: 1) }
        .accessibilityElement(children: .contain)
    }

    /// 新版刚换进来的一次性提示
    private func noticeBanner(_ notice: String) -> some View {
        Button {
            if let summary = document.sync?.summary, !summary.isEmpty { message = summary }
            document.notice = nil
        } label: {
            HStack(spacing: 9) { IndicatorLight(light: .go); Text(notice).lineLimit(2); Spacer() }
                .font(.footnote).foregroundStyle(Skin.ink)
                .padding(.horizontal, 14).frame(minHeight: 42)
                .background(PaperSurface(color: Tone.back.soft))
                .overlay(alignment: .bottom) { Rectangle().fill(Skin.rule).frame(height: 1) }
        }
        .buttonStyle(.plain)
    }

    // MARK: 上栏:返回、文件名与指示灯、大纲、批注、「…」

    private func topBar(_ status: ReaderStatus) -> some View {
        let ink = LeatherInk(cover: cover, scheme: scheme)
        return HStack(spacing: 8) {
            Button { dismiss() } label: { RoundIcon(systemName: "chevron.left", size: 36) }
                .buttonStyle(RaisedButtonStyle(shape: .circle))
                .accessibilityLabel("返回")
            VStack(spacing: 2) {
                Text(document.name).font(.headline).foregroundStyle(ink.primary).lineLimit(1)
                HStack(spacing: 5) {
                    IndicatorLight(light: status.subtitleTone.light, blinking: status.subtitleTone == .ai, size: 7)
                    Text(status.subtitle).font(.caption.weight(.semibold)).foregroundStyle(ink.secondary).lineLimit(1)
                }
            }
            .shadow(color: ink.shadow, radius: 0.5, y: 0.5)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            Button { showOutline = true } label: { RoundIcon(systemName: "list.bullet", size: 36) }
                .buttonStyle(RaisedButtonStyle(shape: .circle))
                .disabled(document.outline.isEmpty)
                .accessibilityLabel("大纲")
            Button { showNotes = true } label: { RoundIcon(systemName: "text.bubble", size: 36) }
                .buttonStyle(RaisedButtonStyle(shape: .circle))
                .overlay(alignment: .topTrailing) { badge }
                .accessibilityLabel(document.roundNotesCount > 0 ? "批注,本轮 \(document.roundNotesCount) 条" : "批注")
            moreMenu(status)
        }
        .padding(.horizontal, 10).frame(height: 54)
        .background(
            LeatherSurface()
                .shadow(color: scheme == .dark ? .black.opacity(0.45) : Skin.color(cover.shade, alpha: 0.28), radius: 4, y: 2)
                .ignoresSafeArea(edges: .top)
        )
    }

    /// 本轮批注数:荧光笔黄的小圆贴(批注都是黄的;红色只留给出问题)
    private var badge: some View {
        Group {
            let count = document.roundNotesCount
            if count > 0 { CountBadge(count: count).offset(x: 6, y: -5).allowsHitTesting(false) }
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
        } label: { RoundIcon(systemName: "ellipsis", size: 36) }
        .menuStyle(.button)
        .buttonStyle(RaisedButtonStyle(shape: .circle))
        .accessibilityLabel("更多")
    }

    // MARK: 下栏:左边状态 / 批注这段,右边主按钮

    private func bottomBar(_ status: ReaderStatus) -> some View {
        let ink = LeatherInk(cover: cover, scheme: scheme)
        return HStack(spacing: 10) {
            if let pending = confirmFinalize {
                finalizeConfirm(pending, ink: ink)
            } else if hasSelection && status.canAnnotate && !showingChanges {
                Button { bridge?.requestAnnotation() } label: {
                    Label("批注这段", systemImage: "highlighter")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16).frame(minHeight: 40)
                }
                .buttonStyle(HighlighterButtonStyle())
                .transition(.opacity)
                Spacer(minLength: 0)
                if let primary = status.primary { primaryButton(primary) }
            } else {
                statusSlot(status, ink: ink)
                if let primary = status.primary { primaryButton(primary) }
            }
        }
        .padding(.horizontal, 14).padding(.top, 9).padding(.bottom, 6)
        .background(
            LeatherSurface()
                .shadow(color: scheme == .dark ? .black.opacity(0.45) : Skin.color(cover.shade, alpha: 0.25), radius: 4, y: -2)
                .ignoresSafeArea(edges: .bottom)
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: hasSelection)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: confirmFinalize)
    }

    /// 定稿要再点一次确认(它会告诉 AI「审阅结束」)。确认就在下栏原地做,不从顶上弹框(2026-10-15 用户提);
    /// 再按一次火漆印才算定稿
    @ViewBuilder
    private func finalizeConfirm(_ pending: ReaderStatus.Primary, ink: LeatherInk) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(pending == .approve ? "通过并定稿?" : "确认定稿?").font(.subheadline.weight(.semibold)).foregroundStyle(ink.primary).lineLimit(1)
            Text(pending == .approve ? "没有批注,AI 会收到「审阅结束」" : "AI 会收到「审阅结束」").font(.caption).foregroundStyle(ink.secondary).lineLimit(1)
        }
        .shadow(color: ink.shadow, radius: 0.5, y: 0.5)
        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
        .accessibilityElement(children: .combine)
        Button { confirmFinalize = nil } label: {
            Text("取消").font(.subheadline.weight(.semibold)).padding(.horizontal, 14).frame(minHeight: 36)
        }
        .buttonStyle(RaisedButtonStyle())
        Button {
            if let target = finalizeTarget { store.requestFinalize(for: document, expected: target) }
            confirmFinalize = nil
        } label: {
            Text("盖章").font(.subheadline.weight(.bold)).foregroundStyle(Skin.warn)
                .padding(.leading, 14).padding(.trailing, 34).frame(minHeight: 36)
        }
        .buttonStyle(RaisedButtonStyle())
        .overlay(alignment: .trailing) { SealImage(size: 50).offset(x: 12).allowsHitTesting(false) }
        .padding(.trailing, 12)
        .accessibilityLabel(pending == .approve ? "通过并定稿" : "盖章定稿")
    }

    private func statusSlot(_ status: ReaderStatus, ink: LeatherInk) -> some View {
        Button {
            if status.statusTap == .openNotes { showNotes = true }
            if status.statusTap == .dismissFinalize, let docId = document.sync?.docId { store.dismissFinalizeRejection(docId: docId) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(status.statusLine).font(.subheadline.weight(.semibold)).foregroundStyle(ink.primary).lineLimit(1)
                if let detail = status.statusDetail {
                    Text(detail).font(.caption).foregroundStyle(ink.secondary).lineLimit(1)
                }
            }
            .shadow(color: ink.shadow, radius: 0.5, y: 0.5)
            .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(status.statusTap != nil)
        .accessibilityHint(status.statusTap == .openNotes ? "打开批注列表" : status.statusTap == .dismissFinalize ? "收起这条说明" : "")
    }

    /// 右边的主按钮:凸起的米白按钮块;定稿是纸签右端压一枚火漆印;「交给 AI」带一个本轮条数的小圆贴
    @ViewBuilder
    private func primaryButton(_ primary: ReaderStatus.Primary) -> some View {
        let (label, enabled) = primaryLabel(primary)
        switch primary {
        case .finalize, .approve:
            Button { perform(primary) } label: {
                Text(label).font(.subheadline.weight(.semibold)).lineLimit(1)
                    .padding(.leading, 15).padding(.trailing, 36).frame(minHeight: 40)
            }
            .buttonStyle(RaisedButtonStyle())
            .overlay(alignment: .trailing) { SealImage(size: 52).offset(x: 13).allowsHitTesting(false) }
            .padding(.trailing, 13)
            .fixedSize(horizontal: true, vertical: false)
        case .handOff(let count), .exportBatch(let count):
            Button { perform(primary) } label: {
                HStack(spacing: 7) {
                    Image(systemName: "paperplane").font(.subheadline.weight(.semibold))
                    Text(label.components(separatedBy: " · ").first ?? label).font(.subheadline.weight(.semibold)).lineLimit(1)
                    CountBadge(count: count)
                }
                .padding(.leading, 15).padding(.trailing, 10).frame(minHeight: 40)
            }
            .buttonStyle(RaisedButtonStyle())
            .accessibilityLabel(label)
            .fixedSize(horizontal: true, vertical: false)
        default:
            Button { perform(primary) } label: {
                Text(label).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                    .padding(.horizontal, 16).frame(minWidth: 96, minHeight: 40)
            }
            .buttonStyle(RaisedButtonStyle(enabled: enabled))
            .disabled(!enabled)
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    private func primaryLabel(_ primary: ReaderStatus.Primary) -> (String, Bool) {
        switch primary {
        case .handOff(let count): return ("交给 AI · \(count)", true)
        case .handOffDisabled: return ("交给 AI", false)
        case .finalize: return ("盖章定稿", true)
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
        case .handOffDisabled:
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
        case .chrome(let hidden): scrollHidden = hidden
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

/// 本轮条数的小圆贴:荧光笔黄,深色字
struct CountBadge: View {
    let count: Int
    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.bold).monospacedDigit()).foregroundStyle(Skin.color(0x4A3407))
            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
            .background(Capsule().fill(LinearGradient(colors: [Skin.color(0xF8D56C), Skin.color(0xE9B23A)], startPoint: .top, endPoint: .bottom)))
            .overlay(Capsule().stroke(Skin.card, lineWidth: 1.5))
            .shadow(color: .black.opacity(0.2), radius: 1, y: 1)
            .accessibilityHidden(true)
    }
}

/// 弹出页的纸面:底色 + 纸纤维;列表去掉系统底色;标题用纸上的墨(系统标题在夜读下是白字,压在台灯下的浅色纸上看不清)
private struct PaperSheet: ViewModifier {
    let title: String
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .background(PaperSurface())
            .presentationBackground { PaperSurface() }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(.headline).foregroundStyle(Skin.inkStrong).accessibilityAddTraits(.isHeader)
                }
            }
    }
}

/// 弹出页里的分组小标题
private struct SheetHeader: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote.weight(.semibold)).foregroundStyle(Skin.muted).textCase(nil)
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
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    }
                } header: {
                    HStack(spacing: 8) {
                        Sticker(text: "采纳 \(results.applied)", applied: true)
                        Sticker(text: "未采纳 \(results.wontfix)", applied: false)
                    }
                    .padding(.bottom, 4)
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("点一条,正文会跳到那一句。")
                        if results.truncated == true || results.items.count < results.total { Text("只带过来前 \(results.items.count) 条,其余在 Mac 上看。") }
                    }
                    .font(.footnote).foregroundStyle(Skin.muted)
                }
            }
            .listStyle(.plain)
            .modifier(PaperSheet(title: "第 \(round) 轮 · 逐条结果"))
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ item: RoundResults.Item) -> some View {
        HStack(alignment: .top, spacing: 12) {
            let applied = item.status == "applied"
            Image(systemName: applied ? "checkmark" : item.status == "wontfix" ? "xmark" : "ellipsis")
                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                .frame(width: 24, height: 24)
                .background(Circle().fill(LinearGradient(colors: applied ? [Skin.mint1, Skin.mint2] : item.status == "wontfix" ? [Skin.coral1, Skin.coral2] : [Skin.color(0xECD497), Skin.color(0xDCBD70)], startPoint: .topLeading, endPoint: .bottomTrailing)))
                .overlay(Circle().stroke(Skin.card, lineWidth: 2))
                .shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)
            VStack(alignment: .leading, spacing: 6) {
                if item.scope == "document" {
                    Text("总体意见").font(.caption.bold()).foregroundStyle(Skin.noteQuote)
                } else if !item.quote.isEmpty {
                    Text("“\(item.quote)”").font(SkinFont.serif(14, bold: true)).foregroundStyle(Skin.inkStrong).lineLimit(3)
                }
                (Text("你:").bold() + Text(item.you)).font(.subheadline).foregroundStyle(Skin.pen)
                (Text("AI:").bold() + Text(item.ai)).font(.subheadline).foregroundStyle(Skin.ink2)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .paperCard()
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
                        .font(item.level == 1 ? SkinFont.serif(17, bold: true) : SkinFont.serif(16))
                        .foregroundStyle(Skin.inkStrong)
                        .padding(.leading, CGFloat(max(0, item.level - 1)) * 16)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(Skin.rule)
            }
            .listStyle(.plain)
            .modifier(PaperSheet(title: "大纲"))
        }
        .presentationDetents([.medium, .large])
    }
}

/// 批注列表:未交(可改可删)/ 已交出 · 等待 Mac 收到 / Mac 已收到 / 被 Mac 拒收(附原因)/ 旧版本上的批注(只读)。
/// 每一条是一张黄便签;往左滑修改、删除
struct NotesSheet: View {
    @ObservedObject var document: OpenedDocument
    let canAnnotate: Bool
    /// 复制到本轮(被拒收的、旧版本上的)
    let onCopy: (Note) -> Void
    let onFocus: (String) -> Void
    let onEdit: (Note) -> Void
    let onDelete: (Note) -> Void

    private func noteRow<Content: View>(_ note: Note, dimmed: Bool = false, @ViewBuilder extra: () -> Content = { EmptyView() }) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            NoteRow(note: note)
            extra()
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(dimmed ? 0.78 : 1)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
        .listRowBackground(StickyNoteBackground().padding(.vertical, 6).padding(.horizontal, 16).opacity(dimmed ? 0.85 : 1))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if document.openNotes.isEmpty {
                        Text(canAnnotate ? "还没有批注。选中正文文字就能批注。" : "没有未交的批注。").foregroundStyle(Skin.muted)
                            .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                    ForEach(document.openNotes) { note in
                        noteRow(note)
                            .contentShape(Rectangle())
                            .onTapGesture { if !note.isDocumentScope { onFocus(note.id) } }
                            .swipeActions {
                                Button(role: .destructive) { onDelete(note) } label: { Label("删除", systemImage: "trash") }
                                Button { onEdit(note) } label: { Label("修改", systemImage: "pencil") }.tint(Skin.pen)
                            }
                    }
                } header: {
                    SheetHeader(text: "未交 \(document.openNotes.count)")
                } footer: {
                    Text(!canAnnotate && !document.openNotes.isEmpty ? "这一轮已经交出或结束,这些没交的批注不会进这一轮。" : "交出前都能改、能删:往左滑一条。点一条,正文会跳到那一句。")
                        .font(.footnote).foregroundStyle(Skin.muted)
                }
                if !document.submittedNotes.isEmpty {
                    Section {
                        ForEach(document.submittedNotes) { note in
                            noteRow(note, dimmed: true)
                                .contentShape(Rectangle())
                                .onTapGesture { if !note.isDocumentScope { onFocus(note.id) } }
                        }
                    } header: {
                        SheetHeader(text: document.sync == nil ? "已导出 · 等待 Mac 导入 \(document.submittedNotes.count)" : "已交出 · 等待 Mac 收到 \(document.submittedNotes.count)")
                    } footer: {
                        Text("交出的批注锁定,不能再改。").font(.footnote).foregroundStyle(Skin.muted)
                    }
                }
                if !document.receivedNotes.isEmpty {
                    Section {
                        ForEach(document.receivedNotes) { note in
                            noteRow(note, dimmed: true)
                                .contentShape(Rectangle())
                                .onTapGesture { if !note.isDocumentScope { onFocus(note.id) } }
                        }
                    } header: { SheetHeader(text: "Mac 已收到 \(document.receivedNotes.count)") }
                }
                if !document.rejectedNotes.isEmpty {
                    Section {
                        ForEach(document.rejectedNotes) { note in
                            noteRow(note) {
                                Text(note.rejectedReason ?? "Mac 没有收下").font(.caption).foregroundStyle(Skin.warn)
                            }
                            .swipeActions { if canAnnotate { copyButton(note) } }
                        }
                    } header: {
                        SheetHeader(text: "被 Mac 拒收 \(document.rejectedNotes.count)")
                    } footer: {
                        Text("这些批注留在手机上,不会丢。原因见每条下方。").font(.footnote).foregroundStyle(Skin.muted)
                    }
                }
                let older = document.olderVersionNotes
                if !older.isEmpty {
                    Section {
                        ForEach(older) { note in
                            noteRow(note, dimmed: true) {
                                Text(olderLabel(note)).font(.caption).foregroundStyle(Skin.muted)
                            }
                            .swipeActions { if canAnnotate && (note.isOpen || note.isRejected) { copyButton(note) } }
                        }
                    } header: {
                        SheetHeader(text: "旧版本上的批注 \(older.count)")
                    } footer: {
                        Text(canAnnotate ? "这些批注写在旧版上,只读保留。左滑「复制到本轮」可以在这一轮再交一次。" : "正文已换成新版。这些批注写在旧版上,只读保留,不会再交出。")
                            .font(.footnote).foregroundStyle(Skin.muted)
                    }
                }
            }
            .listStyle(.plain)
            .modifier(PaperSheet(title: "批注"))
        }
        .presentationDetents([.medium, .large])
    }

    private func copyButton(_ note: Note) -> some View {
        Button { onCopy(note) } label: { Label("复制到本轮", systemImage: "doc.on.doc") }.tint(Skin.pen)
    }

    private func olderLabel(_ note: Note) -> String {
        if note.isOpen { return "没交" }
        if note.isSubmitted { return document.sync == nil ? "已导出" : "已交出" }
        if note.isReceived { return "Mac 已收到" }
        if note.isRejected { return "被 Mac 拒收" }
        return note.status
    }
}

/// 一条批注:上面一行是引文(宋体、灰),下面是你写的意见(蓝墨水)
struct NoteRow: View {
    let note: Note
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if note.isDocumentScope {
                Text("总体意见").font(.caption.bold()).foregroundStyle(Skin.noteQuote)
            } else if !note.quote.isEmpty {
                Text("“\(note.quote)”").font(SkinFont.serif(13)).foregroundStyle(Skin.noteQuote).lineLimit(3)
            }
            Text(note.comment).font(.body).foregroundStyle(Skin.pen)
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
                    Text("针对全篇的意见,不锚定文字").font(.footnote).foregroundStyle(Skin.muted)
                } else if !quote.isEmpty {
                    // 引用的原文:像用荧光笔划过的那一句
                    Text(quote).font(SkinFont.serif(15)).foregroundStyle(Skin.ink2).lineLimit(4)
                        .padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Skin.highlight.opacity(0.24), in: RoundedRectangle(cornerRadius: 4))
                        .overlay(alignment: .leading) { Rectangle().fill(Skin.color(0xF0A028, alpha: 0.75)).frame(width: 3) }
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                TextEditor(text: $text)
                    .focused($focused)
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(Skin.pen)
                    .font(.body)
                    .frame(minHeight: 140)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.45)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Skin.btnEdge, lineWidth: 0.75))
                Spacer()
            }
            .padding()
            .modifier(PaperSheet(title: isDocumentScope ? (initial.isEmpty ? "写总体意见" : "修改总体意见") : (initial.isEmpty ? "写批注" : "修改批注")))
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
