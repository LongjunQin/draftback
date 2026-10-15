import XCTest
@testable import Draftback

/// 跨端规则第 9 节:换 iCloud 账号时,原账号的本地镜像与待上传批次整份收起、不显示;换回原账号再放回来接着用。
@MainActor
final class AccountSwitchTests: XCTestCase {
    func testSwitchShelvesAndRestoresMirrorAndOutbox() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("draftback-account-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: dir) }
        _ = CloudSyncEngine(dataDirectory: dir) // 建好目录
        // 原账号 A 的镜像:一篇稿件 + 一批没传上去的批注
        let doc = SyncedDocument(docId: "dA", reviewId: "rA", title: "A 的稿子.md", round: 1, status: "", applyMode: "", phoneState: "reviewing",
                                 contentHash: "h", summary: "", openCount: 0, pushedAt: Date(), pusher: "Mac", contentAvailable: true,
                                 updatedAt: Date(), revision: 1)
        try JSONEncoder().encode([doc]).write(to: dir.appendingPathComponent("synced/index.json"))
        try fm.createDirectory(at: dir.appendingPathComponent("synced/dA"), withIntermediateDirectories: true)
        try Data("# A".utf8).write(to: dir.appendingPathComponent("synced/dA/content.md"))
        try Data("{}".utf8).write(to: dir.appendingPathComponent("sync/outbox/bA.json"))

        let engine = CloudSyncEngine(dataDirectory: dir)
        XCTAssertEqual(engine.documents.map(\.docId), ["dA"])
        XCTAssertEqual(engine.pendingUploads, 1)

        engine.switchAccount(from: "acctA", to: "acctB")
        XCTAssertTrue(engine.documents.isEmpty, "换成 B:不显示 A 的稿件")
        XCTAssertEqual(engine.pendingUploads, 0, "A 的待上传批次不在 B 的队列里")
        XCTAssertFalse(fm.fileExists(atPath: dir.appendingPathComponent("synced/dA/content.md").path))
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("sync/container").path), "新账号的同步目录也写好容器标记(下次启动不会被当成换容器清掉)")

        engine.switchAccount(from: "acctB", to: "acctA")
        XCTAssertEqual(engine.documents.map(\.docId), ["dA"], "换回 A:稿件回来")
        XCTAssertEqual(engine.pendingUploads, 1, "A 的待上传批次回来,接着传")
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("synced/dA/content.md").path))
    }
}
