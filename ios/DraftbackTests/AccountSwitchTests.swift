import XCTest
@testable import Draftback

/// 跨端规则第 9 节:每个 iCloud 账号一个目录;第一次知道账号时把老位置的数据整理进去(只搬一次、目标已有不动、绝不删),
/// 之后换账号只换指针。原账号的稿件、待上传批次、批注、定稿请求不显示也不上传,换回来接着用。
@MainActor
final class AccountSwitchTests: XCTestCase {
    private let fm = FileManager.default

    private func makeLegacy(in dir: URL) throws {
        _ = CloudSyncEngine(dataDirectory: dir) // 老位置的目录
        let doc = SyncedDocument(docId: "dA", reviewId: "rA", title: "A 的稿子.md", round: 1, status: "", applyMode: "", phoneState: "reviewing",
                                 contentHash: "h", summary: "", openCount: 0, pushedAt: Date(), pusher: "Mac", contentAvailable: true,
                                 updatedAt: Date(), revision: 1)
        try JSONEncoder().encode([doc]).write(to: dir.appendingPathComponent("synced/index.json"))
        try fm.createDirectory(at: dir.appendingPathComponent("synced/dA"), withIntermediateDirectories: true)
        try Data("# A".utf8).write(to: dir.appendingPathComponent("synced/dA/content.md"))
        try Data("{}".utf8).write(to: dir.appendingPathComponent("sync/outbox/bA.json"))
        try fm.createDirectory(at: dir.appendingPathComponent("annotations"), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: dir.appendingPathComponent("annotations/\(Hashing.sha256("synced:dA")).annotations.json"))
        try Data("{}".utf8).write(to: dir.appendingPathComponent("annotations/\(Hashing.sha256("local:x")).annotations.json"))
        try Data(#"{"dA":{}}"#.utf8).write(to: dir.appendingPathComponent("finalize.json"))
    }

    func testFirstAccountAdoptsLegacyThenSwitchesByPointer() throws {
        let dir = fm.temporaryDirectory.appendingPathComponent("draftback-account-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: dir) }
        try makeLegacy(in: dir)
        let engine = CloudSyncEngine(dataDirectory: dir)
        XCTAssertEqual(engine.documents.map(\.docId), ["dA"], "还不知道账号时用老位置")

        try engine.useAccount("acctA")
        let base = dir.appendingPathComponent("accounts/acctA")
        XCTAssertEqual(engine.accountBase.standardizedFileURL, base.standardizedFileURL)
        XCTAssertEqual(engine.documents.map(\.docId), ["dA"])
        XCTAssertEqual(engine.pendingUploads, 1)
        XCTAssertTrue(fm.fileExists(atPath: base.appendingPathComponent("synced/dA/content.md").path))
        XCTAssertTrue(fm.fileExists(atPath: base.appendingPathComponent("annotations/\(Hashing.sha256("synced:dA")).annotations.json").path), "稿件的批注跟进账号目录")
        XCTAssertTrue(fm.fileExists(atPath: base.appendingPathComponent("finalize.json").path), "定稿请求跟进账号目录")
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("annotations/\(Hashing.sha256("local:x")).annotations.json").path), "本机文件的批注留在原处")
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("accounts/active"), encoding: .utf8), "acctA")
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("accounts/legacy-owner"), encoding: .utf8), "acctA")

        try engine.useAccount("acctB")
        XCTAssertTrue(engine.documents.isEmpty, "换成 B:不显示 A 的稿件")
        XCTAssertEqual(engine.pendingUploads, 0, "A 的待上传批次不在 B 的队列里")
        XCTAssertTrue(fm.fileExists(atPath: base.appendingPathComponent("sync/outbox/bA.json").path), "A 的东西原地留着,没有搬也没有删")

        try engine.useAccount("acctA")
        XCTAssertEqual(engine.documents.map(\.docId), ["dA"], "换回 A:接着用")
        XCTAssertEqual(engine.pendingUploads, 1)

        // 重启后按指针直接用 A 的目录
        let restarted = CloudSyncEngine(dataDirectory: dir)
        XCTAssertEqual(restarted.documents.map(\.docId), ["dA"])
    }

    func testInterruptedAdoptionResumesWithoutDeleting() throws {
        let dir = fm.temporaryDirectory.appendingPathComponent("draftback-account-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: dir) }
        try makeLegacy(in: dir)
        // 上次整理到一半就退出了:镜像已经搬过去,同步状态还在老位置,指针没写
        let base = dir.appendingPathComponent("accounts/acctA")
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        try fm.moveItem(at: dir.appendingPathComponent("synced"), to: base.appendingPathComponent("synced"))
        try fm.removeItem(at: dir.appendingPathComponent("finalize.json")) // 只能从新位置的清单认出 dA
        let engine = CloudSyncEngine(dataDirectory: dir) // 老位置会重建一个空的 synced/
        try engine.useAccount("acctA")
        XCTAssertEqual(engine.documents.map(\.docId), ["dA"], "已搬过去的镜像没被空目录覆盖")
        XCTAssertEqual(engine.pendingUploads, 1, "剩下的同步状态这次搬过去了")
        XCTAssertTrue(fm.fileExists(atPath: base.appendingPathComponent("synced/dA/content.md").path))
        XCTAssertTrue(fm.fileExists(atPath: base.appendingPathComponent("annotations/\(Hashing.sha256("synced:dA")).annotations.json").path),
                      "清单已经搬过去也认得出哪些批注属于稿件")
    }

    func testInterruptedAdoptionKeepsOwnerEvenAfterAccountChange() throws {
        let dir = fm.temporaryDirectory.appendingPathComponent("draftback-account-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: dir) }
        try makeLegacy(in: dir)
        // 上次已经定下老数据归 A、搬了镜像就退出了;这次登录的是 B
        try fm.createDirectory(at: dir.appendingPathComponent("accounts/acctA"), withIntermediateDirectories: true)
        try "acctA".write(to: dir.appendingPathComponent("accounts/legacy-owner"), atomically: true, encoding: .utf8)
        try fm.moveItem(at: dir.appendingPathComponent("synced"), to: dir.appendingPathComponent("accounts/acctA/synced"))
        let engine = CloudSyncEngine(dataDirectory: dir)
        try engine.useAccount("acctB")
        XCTAssertTrue(engine.documents.isEmpty, "B 看不到 A 的稿件")
        XCTAssertEqual(engine.pendingUploads, 0, "A 剩下的待上传批次没有进 B")
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("accounts/acctA/sync/outbox/bA.json").path), "剩下的照旧整理进 A")
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("accounts/acctA/finalize.json").path))
        try engine.useAccount("acctA")
        XCTAssertEqual(engine.documents.map(\.docId), ["dA"])
        XCTAssertEqual(engine.pendingUploads, 1)
    }

    func testPreviousBuildMarkerDecidesLegacyOwner() throws {
        let dir = fm.temporaryDirectory.appendingPathComponent("draftback-account-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: dir) }
        try makeLegacy(in: dir)
        try "acctA".write(to: dir.appendingPathComponent("sync-account"), atomically: true, encoding: .utf8) // 上一版留下的:根目录数据归 A
        let engine = CloudSyncEngine(dataDirectory: dir)
        try engine.useAccount("acctB")
        XCTAssertTrue(engine.documents.isEmpty)
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("accounts/acctA/synced/dA/content.md").path), "按上一版的标记整理进 A")
    }
}
