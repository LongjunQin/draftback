import Foundation

// Draftback Sync:无界面,由 Draftback.app(回稿)启动(也可手动跑,方便排查)。
// 环境变量:DRAFTBACK_DATA_DIR(默认 ~/.draftback)、DRAFTBACK_PARENT_PID(主进程退出则随之退出)、DRAFTBACK_SYNC_INTERVAL(秒,默认 15)
// 参数:--once 只跑一轮就退出(排查用);--delete-records 名1,名2 删除云端记录后退出(排查用)

let environment = ProcessInfo.processInfo.environment
let dataDir = URL(fileURLWithPath: environment["DRAFTBACK_DATA_DIR"] ?? (NSHomeDirectory() + "/.draftback"), isDirectory: true)
try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let parentPid = environment["DRAFTBACK_PARENT_PID"].flatMap { Int32($0) }
let interval = environment["DRAFTBACK_SYNC_INTERVAL"].flatMap { TimeInterval($0) } ?? 15
let log = Logger(dataDir: dataDir)
let loop = SyncLoop(dataDir: dataDir, parentPid: parentPid, interval: interval, log: log)

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

if let index = CommandLine.arguments.firstIndex(of: "--delete-records"), index + 1 < CommandLine.arguments.count {
    let names = CommandLine.arguments[index + 1].split(separator: ",").map(String.init)
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        do { try await loop.deleteRecords(names); log.info("已删除云端记录: \(names.joined(separator: ", "))") } catch { log.error("删除失败: \(Describe.error(error))") }
        semaphore.signal()
    }
    semaphore.wait()
    exit(0)
} else if CommandLine.arguments.contains("--once") {
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        let worked = await loop.tick()
        log.info("单轮结束,\(worked ? "有" : "无")实际工作")
        semaphore.signal()
    }
    semaphore.wait()
    exit(0)
} else {
    Task { await loop.run() }
    RunLoop.main.run()
}
