import Foundation

// MDTurn Sync:无界面,由 MDTurn.app 启动(也可手动跑,方便排查)。
// 环境变量:MDREAD_DATA_DIR(默认 ~/.mdread)、MDTURN_PARENT_PID(主进程退出则随之退出)、MDTURN_SYNC_INTERVAL(秒,默认 15)
// 参数:--once 只跑一轮就退出(排查用)

let environment = ProcessInfo.processInfo.environment
let dataDir = URL(fileURLWithPath: environment["MDREAD_DATA_DIR"] ?? (NSHomeDirectory() + "/.mdread"), isDirectory: true)
try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let parentPid = environment["MDTURN_PARENT_PID"].flatMap { Int32($0) }
let interval = environment["MDTURN_SYNC_INTERVAL"].flatMap { TimeInterval($0) } ?? 15
let log = Logger(dataDir: dataDir)
let loop = SyncLoop(dataDir: dataDir, parentPid: parentPid, interval: interval, log: log)

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

if CommandLine.arguments.contains("--once") {
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
