import XCTest
@testable import Draftback

/// 跨端规则 v2.4 第 6.9 条在手机上的部分:为下一轮写的批注、收下后的目标轮、批次协议版本、终态时接着批与定稿。
final class IntentTests: XCTestCase {
    private let finalText = "# 方案\n\n改完的正文。\n"

    private func sync(_ state: String, outcome: String? = nil, macProtocol: Int? = 3, openCount: Int = 0, reviewId: String = "r1") -> SyncedDocument {
        SyncedDocument(docId: "d1", reviewId: reviewId, title: "方案.md", round: 2, status: "", applyMode: "", phoneState: state,
                       contentHash: Hashing.sha256(finalText), summary: "", openCount: openCount, pushedAt: Date(), pusher: "Mac",
                       contentAvailable: true, updatedAt: Date(), revision: 1, outcome: outcome, agentState: nil, results: nil, macProtocol: macProtocol)
    }
    private func document(_ sync: SyncedDocument, notes: [Note] = []) -> OpenedDocument {
        OpenedDocument(url: URL(fileURLWithPath: "/tmp/c.md"), markdown: finalText, assets: [:], notes: notes, securityScoped: false, storageKey: "synced:d1", sync: sync)
    }
    private func note(_ id: String, status: String = "open", intent: String? = "next-round", reviewId: String = "r1", accepted: String? = nil) -> Note {
        var raw: [String: Any] = ["id": id, "comment": "c", "quote": "q", "status": status, "docId": "d1", "reviewId": reviewId, "baseVersion": Hashing.sha256(finalText)]
        if let intent { raw["intent"] = intent }
        if let accepted { raw["acceptedReviewId"] = accepted }
        if status == "submitted" { raw["submittedBatchId"] = "b1"; raw["submittedAt"] = "2026-10-15T00:00:00Z" }
        return Note(raw: raw)
    }

    func testAcceptedRoundWinsForBelonging() {
        let accepted = note("p1", status: "received", accepted: "r2")
        XCTAssertTrue(accepted.belongs(toVersion: Hashing.sha256(finalText), reviewId: "r2"), "收下后归新一轮")
        XCTAssertFalse(accepted.belongs(toVersion: Hashing.sha256(finalText), reviewId: "r1"))
        XCTAssertEqual(accepted.reviewId, "r1", "创建身份不变")
    }

    func testBatchProtocolVersion() throws {
        func json(_ batch: AnnotationBatch) throws -> [String: Any] { try JSONSerialization.jsonObject(with: batch.asJSONData()) as! [String: Any] }
        let v3 = try json(AnnotationBatch(batchId: "b", documentName: "a.md", baseVersion: "h", completedAt: "t", device: "d", annotationsJSON: "[]", docId: "d1", reviewId: "r1", intent: "finalize"))
        XCTAssertEqual(v3["version"] as? Int, 3)
        XCTAssertEqual(v3["intent"] as? String, "finalize")
        let v2 = try json(AnnotationBatch(batchId: "b", documentName: "a.md", baseVersion: "h", completedAt: "t", device: "d", annotationsJSON: "[]", docId: "d1", reviewId: "r1"))
        XCTAssertEqual(v2["version"] as? Int, 2)
        XCTAssertNil(v2["intent"])
        let v1 = try json(AnnotationBatch(batchId: "b", documentName: "a.md", baseVersion: "h", completedAt: "t", device: "d", annotationsJSON: "[]", intent: "finalize"))
        XCTAssertEqual(v1["version"] as? Int, 1, "没有轮次身份(手机独立文件)不带意图")
        XCTAssertNil(v1["intent"])
    }

    func testTerminalViewSeparatesNextRoundFromLeftovers() {
        let doc = document(sync("completed"), notes: [note("p1"), note("x1", intent: nil)])
        XCTAssertTrue(doc.writesNextRound)
        XCTAssertTrue(doc.annotationAllowed)
        XCTAssertEqual(doc.openNotes.map(\.id), ["p1"], "只有为下一轮写的算本轮可交")
        XCTAssertTrue(doc.olderVersionNotes.contains { $0.id == "x1" }, "上一轮遗留的没交批注当旧批注")
        XCTAssertFalse(document(sync("completed", macProtocol: nil)).annotationAllowed, "旧 Mac:稿子回来后手机上不能接着批")
    }

    private func status(_ sync: SyncedDocument, open: Int = 0, inFlight: Int = 0, finalize: ReaderStatus.FinalizeState? = nil) -> ReaderStatus {
        ReaderStatus.make(.init(sync: sync, annotationAllowed: true, newerVersionAvailable: false, latestRound: nil, open: open,
                                supportsIntents: sync.supportsIntents, macOpenCount: sync.openCount, finalize: finalize, nextRoundInFlight: inFlight))
    }

    func testTerminalStatesWithIntents() {
        let back = status(sync("completed"))
        XCTAssertTrue(back.canAnnotate)
        XCTAssertEqual(back.primary, .finalize)
        XCTAssertEqual(back.statusDetail, "划词就开始第 3 轮")
        XCTAssertEqual(status(sync("completed"), open: 2).primary, .handOff(2))
        let inFlight = status(sync("completed"), inFlight: 2)
        XCTAssertFalse(inFlight.canAnnotate, "交出后、新一轮快照到之前不能再为旧轮写")
        XCTAssertEqual(inFlight.primary, .handedOff)
        XCTAssertNil(status(sync("finalized")).primary, "已定稿不再定稿")
        XCTAssertTrue(status(sync("finalized")).canAnnotate, "定稿后再批就开新一轮")
        XCTAssertEqual(status(sync("completed", outcome: "approved")).primary, .finalize)
        XCTAssertFalse(status(sync("completed", macProtocol: nil)).canAnnotate, "旧 Mac 照旧")
    }

    func testFinalizeStates() {
        let pending = status(sync("completed"), finalize: .pending)
        XCTAssertEqual(pending.statusLine, "已请求定稿")
        XCTAssertNil(pending.primary)
        XCTAssertFalse(pending.canAnnotate)
        let rejected = status(sync("completed"), finalize: .rejected("Mac 上这篇还有没处理的批注"))
        XCTAssertEqual(rejected.statusLine, "没有定稿")
        XCTAssertEqual(rejected.statusTap, .dismissFinalize)
        XCTAssertEqual(rejected.primary, .finalize, "可以再试")
    }

    func testApproveOnlyWhenNothingToHandOff() {
        XCTAssertEqual(status(sync("reviewing")).primary, .approve, "一条批注都没有:通过 · 定稿")
        XCTAssertEqual(status(sync("reviewing", openCount: 2)).primary, .handOffDisabled, "Mac 上有批注:不能直接通过")
        XCTAssertEqual(status(sync("reviewing", macProtocol: nil)).primary, .handOffDisabled, "旧 Mac 不给")
    }
}
