import SwiftUI
import WebKit
import UIKit

/// 在系统文字选择菜单里加一项「批注」:选中正文文字 → 菜单 → 批注,走与 Mac 一致的锚点算法。
/// 这一轮不能批注时(已交出、已定稿……)不加这一项。
final class AnnotatingWebView: WKWebView {
    var onAnnotateRequested: (() -> Void)?
    var annotationEnabled = true

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard annotationEnabled else { return }
        let annotate = UIAction(title: "批注", image: UIImage(systemName: "text.bubble")) { [weak self] _ in
            self?.onAnnotateRequested?()
        }
        builder.insertChild(UIMenu(title: "", options: .displayInline, children: [annotate]), atStartOfMenu: .root)
    }
}

/// 页面 → 原生 的消息。
enum ReaderEvent {
    case ready
    case rendered(outline: [OutlineItem])
    case selection(anchor: [String: Any], quote: String)
    /// 正文里有没有选中文字(底栏左槽据此换成「批注这段」;选区消失 0.2 秒后才报 false)
    case selectionState(Bool)
    /// 回稿卡「显示改动」开着没有(开着时不能批注:对比是只读视图)
    case changesState(Bool)
    /// 回稿卡上点了「逐条结果」
    case showResults
    /// 逐条结果点一条,正文里找不到那句(被改掉了)
    case locateFailed
    case noSelection
    case error(String)
}

struct ReaderWebView: UIViewRepresentable {
    let document: OpenedDocument
    @Binding var reloadToken: Int
    /// 正文整体替换的次数(Mac 推来新版):变了就重载整页正文
    let contentVersion: Int
    /// 正文字号倍数(系统动态字体 × 用户选的一档)
    let fontScale: Double
    /// 这一轮能不能批注:决定系统菜单里有没有「批注」
    let annotationEnabled: Bool
    /// 回稿卡相关状态(轮次、状态、上一版):变了就重画网页
    let cardKey: String
    let onEvent: (ReaderEvent) -> Void
    let onReady: (ReaderBridge) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEvent: onEvent) }

    func makeUIView(context: Context) -> AnnotatingWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "draftback")
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.isTextInteractionEnabled = true
        let webView = AnnotatingWebView(frame: .zero, configuration: configuration)
        webView.annotationEnabled = annotationEnabled
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .always
        webView.navigationDelegate = context.coordinator
        webView.onAnnotateRequested = { [weak webView] in
            webView?.evaluateJavaScript("window.DraftbackReader && window.DraftbackReader.captureSelection()") { _, _ in }
        }
        context.coordinator.bridge = ReaderBridge(webView: webView)
        context.coordinator.bridge?.fontScale = fontScale
        context.coordinator.lastFontScale = fontScale
        context.coordinator.lastCardKey = cardKey
        context.coordinator.pendingLoad = document
        if let webDirectory = Bundle.main.url(forResource: "Web", withExtension: nil) {
            let page = webDirectory.appendingPathComponent("reader.html")
            webView.loadFileURL(page, allowingReadAccessTo: webDirectory)
        }
        // 不在界面刷新过程中改 SwiftUI 状态:刷新完再把桥交出去,否则赋值可能被丢掉
        if let bridge = context.coordinator.bridge { DispatchQueue.main.async { onReady(bridge) } }
        return webView
    }

    func updateUIView(_ webView: AnnotatingWebView, context: Context) {
        context.coordinator.onEvent = onEvent
        webView.annotationEnabled = annotationEnabled
        if context.coordinator.lastFontScale != fontScale {
            context.coordinator.lastFontScale = fontScale
            context.coordinator.bridge?.fontScale = fontScale
            context.coordinator.bridge?.setFontScale(fontScale)
        }
        if context.coordinator.lastContentVersion != contentVersion || context.coordinator.lastCardKey != cardKey {
            context.coordinator.lastContentVersion = contentVersion
            context.coordinator.lastCardKey = cardKey
            context.coordinator.lastReloadToken = reloadToken
            if context.coordinator.pendingLoad == nil { context.coordinator.bridge?.load(document) } else { context.coordinator.pendingLoad = document }
            return
        }
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            context.coordinator.bridge?.setAnnotations(document.highlightPayload)
        }
    }

    static func dismantleUIView(_ webView: AnnotatingWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "draftback")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        /// 每次 SwiftUI 刷新都换成最新的闭包(它带着当时的状态,如这会儿能不能批注)
        var onEvent: (ReaderEvent) -> Void
        var bridge: ReaderBridge?
        var pendingLoad: OpenedDocument?
        var lastReloadToken = 0
        var lastContentVersion = 0
        var lastFontScale = 1.0
        var lastCardKey = ""

        init(onEvent: @escaping (ReaderEvent) -> Void) { self.onEvent = onEvent }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                if let document = pendingLoad { bridge?.load(document); pendingLoad = nil }
                onEvent(.ready)
            case "rendered":
                let items = (body["outline"] as? [[String: Any]] ?? []).compactMap { item -> OutlineItem? in
                    guard let id = item["id"] as? String, let text = item["text"] as? String else { return nil }
                    return OutlineItem(id: id, level: item["level"] as? Int ?? 1, text: text, line: item["line"] as? Int ?? 0)
                }
                onEvent(.rendered(outline: items))
            case "selectionState":
                onEvent(.selectionState(body["active"] as? Bool ?? false))
            case "changesState":
                onEvent(.changesState(body["showing"] as? Bool ?? false))
            case "returnCard":
                if (body["action"] as? String) == "results" { onEvent(.showResults) }
            case "locateFailed":
                onEvent(.locateFailed)
            case "selection":
                if let anchor = body["anchor"] as? [String: Any] {
                    onEvent(.selection(anchor: anchor, quote: body["quote"] as? String ?? ""))
                } else {
                    onEvent(.noSelection)
                }
            case "error":
                onEvent(.error(body["message"] as? String ?? "未知错误"))
            #if DEBUG
            case "debug":
                print("DraftbackReader debug:", body["text"] as? String ?? "")
            #endif
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // 页面内只允许本地 reader.html;外部 http(s) 链接交给系统浏览器。
            if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}

/// 原生 → 页面 的调用封装。
final class ReaderBridge {
    private weak var webView: AnnotatingWebView?
    var fontScale = 1.0
    init(webView: AnnotatingWebView) { self.webView = webView }

    /// 只发命令、不要返回值(load 返回 Promise,直接交给 evaluateJavaScript 会报"返回类型不受支持")
    private func call(_ script: String) {
        webView?.evaluateJavaScript("void (\(script))") { _, error in
            if let error { print("Draftback reader script error: \(error.localizedDescription)") }
        }
    }

    /// 任意值 → JS 字面量。单个字符串、数字也要能传(大纲跳转、定位批注、找引文都传字符串):
    /// isValidJSONObject 只认数组和字典,所以包一层数组再去掉方括号;以前字符串一律变成 null
    func json(_ object: Any) -> String {
        let wrapped: [Any] = [object]
        guard JSONSerialization.isValidJSONObject(wrapped),
              let data = try? JSONSerialization.data(withJSONObject: wrapped),
              let text = String(data: data, encoding: .utf8), text.count >= 2 else { return "null" }
        return String(text.dropFirst().dropLast())
    }

    func load(_ document: OpenedDocument) {
        let payload: [String: Any] = [
            "markdown": document.markdown,
            "annotations": document.highlightPayload,
            "assets": document.assets,
            "fontScale": fontScale,
            "returnCard": document.returnCard ?? NSNull(),
            "previousMarkdown": document.changesBase ?? NSNull(),
        ]
        call("window.DraftbackReader.load(\(json(payload)))")
    }

    func setAnnotations(_ notes: [[String: Any]]) { call("window.DraftbackReader.setAnnotations(\(json(notes)))") }
    func focus(noteId: String) { call("window.DraftbackReader.focusNote(\(json(noteId)))") }
    func scrollToHeading(_ id: String) { call("window.DraftbackReader.scrollToHeading(\(json(id)))") }
    func clearSelection() { call("window.DraftbackReader.clearSelection()") }
    /// 底栏「批注这段」:和系统菜单的「批注」走同一条路
    func requestAnnotation() { call("window.DraftbackReader.captureSelection()") }
    func setFontScale(_ scale: Double) { call("window.DraftbackReader.setFontScale(\(scale))") }
    /// 回稿卡「显示改动 / 隐藏改动」
    func toggleChanges() { call("window.DraftbackReader.toggleChanges()") }
    /// 「…」里的「回稿卡」:滚到正文最上方
    func scrollToTop() { call("window.DraftbackReader.scrollToTop()") }
    /// 逐条结果点一条:在正文里找到那句引文
    func locateQuote(_ quote: String) { call("window.DraftbackReader.locateQuote(\(json(quote)))") }
    /// 「复制到本轮」:引文在本轮正文里还在就算出锚点;找不到给 nil
    func anchorForQuote(_ quote: String, headingPath: [String], completion: @escaping ([String: Any]?) -> Void) {
        guard let webView else { completion(nil); return }
        webView.evaluateJavaScript("window.DraftbackReader.anchorForQuote(\(json(quote)), \(json(headingPath)))") { result, _ in
            completion(result as? [String: Any])
        }
    }
    #if DEBUG
    /// 仅调试版:模拟器截图时选中第 n 段
    func debugSelectParagraph(_ index: Int) {
        call("(() => { const p = document.querySelectorAll('#content p')[\(index)]; if (!p) return 'no-p'; const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); setTimeout(() => window.webkit.messageHandlers.draftback.postMessage({ type: 'debug', text: 'selected=' + getSelection().toString().length }), 300); return 'ok'; })()")
    }
    #endif

    func createPDF(completion: @escaping (Result<Data, Error>) -> Void) {
        guard let webView else { return }
        let configuration = WKPDFConfiguration()
        webView.createPDF(configuration: configuration) { result in completion(result) }
    }
}
