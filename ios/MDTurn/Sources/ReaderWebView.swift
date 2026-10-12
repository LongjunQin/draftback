import SwiftUI
import WebKit
import UIKit

/// 在系统文字选择菜单里加一项「批注」:选中正文文字 → 菜单 → 批注,走与 Mac 一致的锚点算法。
final class AnnotatingWebView: WKWebView {
    var onAnnotateRequested: (() -> Void)?

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
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
    case noSelection
    case error(String)
}

struct ReaderWebView: UIViewRepresentable {
    let document: OpenedDocument
    @Binding var reloadToken: Int
    let onEvent: (ReaderEvent) -> Void
    let onReady: (ReaderBridge) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEvent: onEvent) }

    func makeUIView(context: Context) -> AnnotatingWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "mdturn")
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.isTextInteractionEnabled = true
        let webView = AnnotatingWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .always
        webView.navigationDelegate = context.coordinator
        webView.onAnnotateRequested = { [weak webView] in
            webView?.evaluateJavaScript("window.MDTurnReader && window.MDTurnReader.captureSelection()") { _, _ in }
        }
        context.coordinator.bridge = ReaderBridge(webView: webView)
        context.coordinator.pendingLoad = document
        if let webDirectory = Bundle.main.url(forResource: "Web", withExtension: nil) {
            let page = webDirectory.appendingPathComponent("reader.html")
            webView.loadFileURL(page, allowingReadAccessTo: webDirectory)
        }
        onReady(context.coordinator.bridge!)
        return webView
    }

    func updateUIView(_ webView: AnnotatingWebView, context: Context) {
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            context.coordinator.bridge?.setAnnotations(document.highlightPayload)
        }
    }

    static func dismantleUIView(_ webView: AnnotatingWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "mdturn")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let onEvent: (ReaderEvent) -> Void
        var bridge: ReaderBridge?
        var pendingLoad: OpenedDocument?
        var lastReloadToken = 0

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
            case "selection":
                if let anchor = body["anchor"] as? [String: Any] {
                    onEvent(.selection(anchor: anchor, quote: body["quote"] as? String ?? ""))
                } else {
                    onEvent(.noSelection)
                }
            case "error":
                onEvent(.error(body["message"] as? String ?? "未知错误"))
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
    init(webView: AnnotatingWebView) { self.webView = webView }

    private func call(_ script: String) {
        webView?.evaluateJavaScript(script) { _, error in
            if let error { print("MDTurn reader script error: \(error.localizedDescription)") }
        }
    }

    private func json(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }

    func load(_ document: OpenedDocument) {
        let payload: [String: Any] = [
            "markdown": document.markdown,
            "annotations": document.highlightPayload,
            "assets": document.assets,
        ]
        call("window.MDTurnReader.load(\(json(payload)))")
    }

    func setAnnotations(_ notes: [[String: Any]]) { call("window.MDTurnReader.setAnnotations(\(json(notes)))") }
    func focus(noteId: String) { call("window.MDTurnReader.focusNote(\(json(noteId)))") }
    func scrollToHeading(_ id: String) { call("window.MDTurnReader.scrollToHeading(\(json(id)))") }
    func clearSelection() { call("window.MDTurnReader.clearSelection()") }

    func createPDF(completion: @escaping (Result<Data, Error>) -> Void) {
        guard let webView else { return }
        let configuration = WKPDFConfiguration()
        webView.createPDF(configuration: configuration) { result in completion(result) }
    }
}
