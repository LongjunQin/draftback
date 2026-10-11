import SwiftUI

/// MDTurn iOS:SwiftUI 外壳 + WKWebView 内核(与 Mac 共用同一套渲染与批注锚点代码)。
/// 首版范围(路线图 v3 第一轮样例):打开本地 Markdown、阅读、划词批注、批注本地持久保存、
/// 导出批注批次(与 Mac sidecar 同格式)与 PDF。同步传输层是可替换接口,CloudKit 接入等开发者账户激活后进行。
@main
struct MDTurnApp: App {
    @StateObject private var store = DocumentStore()

    var body: some Scene {
        WindowGroup {
            LibraryView()
                .environmentObject(store)
                .onOpenURL { url in store.open(url: url, fromExternal: true) }
                // 调试/截图用:xcrun simctl launch ... --open-sample 直接进入示例文档
                .onAppear { if CommandLine.arguments.contains("--open-sample") { store.openSample() } }
        }
    }
}
