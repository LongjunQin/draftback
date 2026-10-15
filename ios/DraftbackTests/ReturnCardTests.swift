import XCTest
@testable import Draftback

/// 回稿卡与「显示改动」的条件:稿子回来了、正文就是这一轮的完成稿才有卡;有上一版才能对比;
/// 上一版不是这一轮的原稿时要说清楚对比的是什么。
final class ReturnCardTests: XCTestCase {
    private let finalText = "# 方案\n\n改完的正文。\n"
    private let originalText = "# 方案\n\n原来的正文。\n"

    private func sync(_ state: String, outcome: String? = nil, reviewId: String = "r2", hash: String? = nil, applyMode: String = "agent") -> SyncedDocument {
        SyncedDocument(docId: "d1", reviewId: reviewId, title: "方案.md", round: 2, status: "", applyMode: applyMode, phoneState: state,
                       contentHash: hash ?? Hashing.sha256(finalText), summary: "按批注改了第二段。", openCount: 0,
                       pushedAt: Date(timeIntervalSince1970: 1_760_500_000), pusher: "Mac", contentAvailable: true,
                       updatedAt: Date(), revision: 5, outcome: outcome, agentState: nil)
    }
    private func document(_ sync: SyncedDocument, previousReviewId: String? = "r2") -> OpenedDocument {
        let doc = OpenedDocument(url: URL(fileURLWithPath: "/tmp/content.md"), markdown: finalText, assets: [:], notes: [],
                                 securityScoped: false, storageKey: "synced:d1", sync: sync)
        if let previousReviewId {
            doc.previous = (originalText, PreviousVersion(hash: Hashing.sha256(originalText), reviewId: previousReviewId, round: 2, savedAt: Date()))
        }
        return doc
    }

    func testCardAppearsWhenDraftCameBack() {
        let doc = document(sync("completed"))
        let card = doc.returnCard
        XCTAssertEqual(card?["title"] as? String, "第 2 轮回稿")
        XCTAssertEqual(card?["summary"] as? String, "按批注改了第二段。")
        XCTAssertTrue((card?["meta"] as? String ?? "").hasSuffix("AI 改的"))
        XCTAssertNil(card?["note"], "上一版就是这一轮的原稿:不用多说")
        XCTAssertEqual(doc.changesBase, originalText)
    }

    func testManualRoundSaysWhoChangedIt() {
        let card = document(sync("completed", applyMode: "manual")).returnCard
        XCTAssertTrue((card?["meta"] as? String ?? "").hasSuffix("你在 Mac 上自己改的"))
    }

    func testNoCardOutsideAReturnedDraft() {
        for state in ["reviewing", "waiting-agent", "applying", "finalized", "cancelled", "restored", "conflict"] {
            XCTAssertNil(document(sync(state)).returnCard, state)
        }
        XCTAssertNil(document(sync("completed", outcome: "approved")).returnCard, "零批注通过:没改东西,不出卡")
        XCTAssertNil(document(sync("completed", hash: "other")).returnCard, "正文还不是这一轮的完成稿:不出卡")
    }

    func testPreviousFromAnotherRoundIsExplained() {
        let doc = document(sync("completed"), previousReviewId: "r1")
        XCTAssertNotNil(doc.returnCard?["note"], "手机错过了这一轮的原稿,要说清楚对比的是手机上的上一版")
        XCTAssertEqual(doc.changesBase, originalText)
    }

    func testNoPreviousMeansNoComparison() {
        let doc = document(sync("completed"), previousReviewId: nil)
        XCTAssertNotNil(doc.returnCard)
        XCTAssertNil(doc.changesBase, "没有上一版:只有卡片,没有「显示改动」")
    }

    func testCardKeyChangesWithState() {
        let doc = document(sync("completed"))
        let before = doc.cardKey
        doc.sync = sync("finalized")
        XCTAssertNotEqual(doc.cardKey, before, "定稿后卡片要收起:网页得重画")
    }
}

/// 原生给网页传值:单个字符串、数字也要变成合法的 JS 字面量(以前字符串一律变成 null,大纲跳转与定位都不灵)
final class BridgeJSONTests: XCTestCase {
    func testScalarsBecomeLiterals() {
        let bridge = ReaderBridge(webView: AnnotatingWebView(frame: .zero, configuration: .init()))
        XCTAssertEqual(bridge.json("draftback-h-2"), "\"draftback-h-2\"")
        XCTAssertEqual(bridge.json("引号\"与</script>"), "\"引号\\\"与<\\/script>\"")
        XCTAssertEqual(bridge.json(3), "3")
        XCTAssertEqual(bridge.json(["a": 1]), "{\"a\":1}")
        XCTAssertEqual(bridge.json(Date()), "null", "不能编码的值给 null,不崩")
    }
}
