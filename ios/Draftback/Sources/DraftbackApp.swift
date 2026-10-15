import SwiftUI
import UIKit
import UserNotifications

/// 回稿(Draftback)iOS:SwiftUI 外壳 + WKWebView 内核(与 Mac 共用同一套渲染与批注锚点代码)。
/// 范围:打开本地 Markdown、阅读、划词批注、批注本地持久保存、导出批注批次与 PDF;
/// 以及跨端规则第 12 节的 CloudKit 同步:接收 Mac 推来的审阅文档,把批注批次交回 Mac,收回执与新版。
@main
struct DraftbackApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = DocumentStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            LibraryView()
                .environmentObject(store)
                .onOpenURL { url in store.open(url: url, fromExternal: true) }
                // 调试/截图用:--open-sample 直接进入示例文档;--open-local <文件名> 打开 App 文件夹里的文档;
                // 仅调试版:--demo-drafts 填入各种状态的演示稿件,--demo-open <文档标识> 直接打开其中一篇
                .onAppear {
                    let args = CommandLine.arguments
                    #if DEBUG
                    if args.contains("--demo-drafts") {
                        store.seedDemo()
                        if let index = args.firstIndex(of: "--demo-open"), index + 1 < args.count {
                            let docId = args[index + 1]
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                                if let doc = store.synced.first(where: { $0.docId == docId }) { store.openSynced(doc) }
                            }
                        }
                    }
                    #endif
                    if let docId = AppDelegate.pendingOpenDocId { AppDelegate.pendingOpenDocId = nil; store.openSynced(docId: docId) }
                    if args.contains("--open-sample") { store.openSample() }
                    if let index = args.firstIndex(of: "--open-local"), index + 1 < args.count {
                        store.openLocal(named: args[index + 1])
                    }
                    store.refreshSync()
                }
                .onChange(of: scenePhase) { _, phase in
                    store.isActive = phase == .active
                    if phase == .active {
                        store.refreshSync()
                        if let doc = store.current?.sync { store.markSeen(doc) } // 回到前台时正在看的稿子算看过
                    }
                }
                // 静默推送不保证到达:前台时每 20 秒自己拉一次(没变化时只是一次极小的增量查询)
                .onReceive(Timer.publish(every: 20, on: .main, in: .common).autoconnect()) { _ in if scenePhase == .active { store.refreshSync() } }
                .onReceive(NotificationCenter.default.publisher(for: AppDelegate.cloudPushNotification)) { _ in store.refreshSync() }
                // 点「回稿了」通知:直接打开那一篇
                .onReceive(NotificationCenter.default.publisher(for: AppDelegate.openDocumentNotification)) { note in
                    if let docId = note.userInfo?["docId"] as? String { AppDelegate.pendingOpenDocId = nil; store.openSynced(docId: docId) }
                }
        }
    }
}

/// 注册静默推送(CloudKit 的区变更通知到达时让文档库去拉取);「回稿了」本地通知的展示与点击。
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let cloudPushNotification = Notification.Name("draftback.cloud.push")
    static let openDocumentNotification = Notification.Name("draftback.open-document")
    /// 冷启动时点通知:界面还没起来,先记下,界面出现时再开
    static var pendingOpenDocId: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        application.registerForRemoteNotifications()
        return true
    }

    /// App 在前台也显示横幅(正在看的那篇,文档库根本不会发)
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let docId = response.notification.request.content.userInfo["docId"] as? String {
            Self.pendingOpenDocId = docId
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Self.openDocumentNotification, object: nil, userInfo: ["docId": docId])
            }
        }
        completionHandler()
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // 模拟器或未签推送权限时会走到这里:不影响使用,回到前台时照样拉取
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard CloudSyncEngine.isCloudKitPush(userInfo) else { completionHandler(.noData); return }
        NotificationCenter.default.post(name: Self.cloudPushNotification, object: nil)
        // 给拉取留几秒;真正的结果由 DocumentStore 落盘,这里只需告诉系统有新数据
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { completionHandler(.newData) }
    }
}
