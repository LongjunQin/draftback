import XCTest
@testable import Draftback

/// 手机端状态逻辑:首页分组与 Mac 左栏同一套规则、「新」与回稿蓝点、已交出三档、读稿页底栏与能否批注、时间说法。
final class DraftStatusTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-15T13:00:00+08:00")!
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return calendar
    }

    private func doc(_ state: String, outcome: String? = nil, agent: String? = nil, round: Int = 2, minutesAgo: Double = 5,
                     reviewId: String = "r2", summary: String = "") -> SyncedDocument {
        SyncedDocument(docId: "d1", reviewId: reviewId, title: "方案.md", round: round, status: "", applyMode: "", phoneState: state,
                       contentHash: "h", summary: summary, openCount: 0, pushedAt: now.addingTimeInterval(-minutesAgo * 60), pusher: "Mac",
                       contentAvailable: true, updatedAt: now, revision: 3, outcome: outcome, agentState: agent)
    }

    func testGroupsFollowMacRules() {
        let cases: [(String, String?, DraftGroup)] = [
            ("reviewing", nil, .yours), ("conflict", nil, .yours), ("completed", nil, .yours), ("completed", "approved", .yours),
            ("restored", nil, .yours), ("waiting-agent", nil, .handed), ("applying", nil, .handed), ("manual-editing", nil, .handed),
            ("finalized", nil, .ended), ("cancelled", nil, .ended), ("something-new", nil, .ended),
        ]
        for (state, outcome, group) in cases {
            XCTAssertEqual(DraftStatus.row(for: doc(state, outcome: outcome), seen: nil, now: now).group, group, state)
        }
    }

    func testNewRoundShowsNewUntilOpened() {
        let reviewing = doc("reviewing")
        XCTAssertTrue(DraftStatus.row(for: reviewing, seen: nil, now: now).isNew)
        XCTAssertTrue(DraftStatus.row(for: reviewing, seen: "r1|completed", now: now).isNew, "上一轮看过不算这一轮看过")
        XCTAssertFalse(DraftStatus.row(for: reviewing, seen: DraftStatus.seenKey(for: reviewing), now: now).isNew)
        XCTAssertEqual(DraftStatus.row(for: reviewing, seen: nil, localOpen: 2, now: now).subtitle, "第 2 轮 · 2 条未交 · 5 分钟前")
    }

    func testDraftBackUnreadUntilSeen() {
        let back = doc("completed")
        XCTAssertTrue(DraftStatus.row(for: back, seen: "r2|applying", now: now).unread)
        XCTAssertFalse(DraftStatus.row(for: back, seen: "r2|completed", now: now).unread)
        XCTAssertFalse(DraftStatus.row(for: doc("completed", outcome: "approved"), seen: nil, now: now).unread, "零批注通过不是回稿")
        XCTAssertEqual(DraftStatus.row(for: back, seen: nil, now: now).subtitle, "第 2 轮回稿 · 5 分钟前")
    }

    func testHandOffTiersUseMacWording() {
        XCTAssertEqual(DraftStatus.row(for: doc("waiting-agent", agent: "none"), seen: nil, now: now).subtitle, "已交出 · 还没有 AI 接入 · 5 分钟前")
        XCTAssertEqual(DraftStatus.row(for: doc("waiting-agent"), seen: nil, now: now).subtitle, "已交出 · 5 分钟前", "旧版 Mac 不推三档:不猜")
        XCTAssertEqual(DraftStatus.row(for: doc("waiting-agent", agent: "listening"), seen: nil, now: now).subtitle, "已交出 · AI 在线,等待领取")
        let claimed = DraftStatus.row(for: doc("waiting-agent", agent: "claimed"), seen: nil, now: now)
        XCTAssertEqual(claimed.subtitle, "AI 正在修改 · 5 分钟")
        XCTAssertTrue(claimed.spinning)
        XCTAssertEqual(claimed.tone, .ai)
        XCTAssertTrue(DraftStatus.row(for: doc("applying", minutesAgo: 75), seen: nil, now: now).subtitle.hasSuffix("1 小时 15 分"))
    }

    func testListeningExpiresWithoutRefresh() {
        // Mac 在 AI 监听期间每 10 分钟重推;超过 20 分钟没刷新(Mac 关机、断网)就不再说 AI 在线
        XCTAssertEqual(DraftStatus.row(for: doc("waiting-agent", agent: "listening", minutesAgo: 8), seen: nil, now: now).subtitle, "已交出 · AI 在线,等待领取")
        XCTAssertEqual(DraftStatus.row(for: doc("waiting-agent", agent: "listening", minutesAgo: 30), seen: nil, now: now).subtitle, "已交出 · 30 分钟前")
        XCTAssertNil(reader(doc("waiting-agent", agent: "listening", minutesAgo: 30)).banner, "过期的监听不出横幅")
    }

    private func reader(_ sync: SyncedDocument?, allowed: Bool = true, open: Int = 0, submitted: Int = 0, received: Int = 0, rejected: Int = 0,
                        pending: Int = 0, submittedMinutesAgo: Double? = nil, newer: Bool = false) -> ReaderStatus {
        ReaderStatus.make(.init(sync: sync, annotationAllowed: allowed, newerVersionAvailable: newer, latestRound: 3,
                                open: open, submitted: submitted, received: received, rejected: rejected, pendingUploads: pending,
                                oldestSubmittedAt: submittedMinutesAgo.map { now.addingTimeInterval(-$0 * 60) }, now: now))
    }

    func testReviewingBottomBar() {
        let reviewing = doc("reviewing")
        XCTAssertEqual(reader(reviewing, open: 2).primary, .handOff(2))
        XCTAssertTrue(reader(reviewing, open: 2).canAnnotate)
        XCTAssertEqual(reader(reviewing).primary, .handOffDisabled)
        // 交出后:等待同步 → 等待 Mac 收到 → 久等没回执给「重新发送」;这期间不能再批注
        let queued = reader(reviewing, submitted: 2, pending: 1, submittedMinutesAgo: 1)
        XCTAssertEqual(queued.statusLine, "等待同步 2 条")
        XCTAssertEqual(queued.primary, .handedOff)
        XCTAssertFalse(queued.canAnnotate)
        XCTAssertEqual(reader(reviewing, submitted: 2, submittedMinutesAgo: 1).statusDetail, "等待 Mac 收到")
        let late = reader(reviewing, submitted: 2, submittedMinutesAgo: 4)
        XCTAssertEqual(late.statusDetail, "等待 Mac 在线")
        XCTAssertEqual(late.primary, .resend)
        XCTAssertEqual(reader(reviewing, received: 2).statusLine, "Mac 已收到 2 条")
        XCTAssertFalse(reader(reviewing, received: 2).canAnnotate)
        // 正文还不是这一轮的:不能批注
        let syncing = reader(reviewing, allowed: false, open: 1)
        XCTAssertFalse(syncing.canAnnotate)
        XCTAssertNil(syncing.primary)
        // 被拒收:点状态看原因
        XCTAssertEqual(reader(reviewing, rejected: 2).statusTap, .openNotes)
    }

    func testHandedOffAndAIStates() {
        XCTAssertNil(reader(doc("waiting-agent")).banner, "旧版 Mac 不推三档:不出横幅")
        let none = reader(doc("waiting-agent", agent: "none"))
        XCTAssertEqual(none.banner?.text, "还没有 AI 接入")
        XCTAssertEqual(none.subtitle, "已交出")
        XCTAssertEqual(none.primary, .handedOff)
        XCTAssertFalse(none.canAnnotate)
        XCTAssertEqual(reader(doc("waiting-agent", agent: "listening")).banner?.text, "AI 在线,等待领取")
        let claimed = reader(doc("waiting-agent", agent: "claimed"), received: 3)
        XCTAssertEqual(claimed.primary, .busy)
        XCTAssertEqual(claimed.statusLine, "Mac 已收到 3 条")
        XCTAssertEqual(claimed.banner?.spinning, true)
        XCTAssertEqual(reader(doc("applying")).primary, .busy)
        XCTAssertEqual(reader(doc("applying")).statusLine, "这一轮在 Mac 上交出")
    }

    func testEndStatesBlockAnnotation() {
        for state in ["completed", "restored", "finalized", "cancelled", "conflict", "manual-editing"] {
            let status = reader(doc(state))
            XCTAssertFalse(status.canAnnotate, state)
            XCTAssertNotNil(status.blockedReason, state)
        }
        XCTAssertEqual(reader(doc("completed")).subtitle, "第 2 轮回稿")
        XCTAssertEqual(reader(doc("completed", outcome: "approved")).statusLine, "已通过 · 没有批注")
        XCTAssertEqual(reader(doc("conflict")).banner?.tone, .conflict)
    }

    func testNewerVersionBanner() {
        let status = reader(doc("reviewing"), open: 1, newer: true)
        XCTAssertEqual(status.banner?.action, .loadNewVersion)
        XCTAssertEqual(status.banner?.text, "Mac 推来了第 3 轮新版")
    }

    func testLocalFiles() {
        XCTAssertEqual(reader(nil, open: 2).primary, .exportBatch(2))
        XCTAssertEqual(reader(nil, submitted: 2).primary, .reexport)
        XCTAssertTrue(reader(nil).canAnnotate)
        XCTAssertEqual(reader(nil).subtitle, "本机文件")
    }

    func testTimeText() {
        XCTAssertEqual(TimeText.clock(now.addingTimeInterval(-20), now: now, calendar: calendar), "刚刚")
        XCTAssertEqual(TimeText.clock(now.addingTimeInterval(-5 * 60), now: now, calendar: calendar), "5 分钟前")
        XCTAssertEqual(TimeText.clock(now.addingTimeInterval(-3 * 3600), now: now, calendar: calendar), "10:00")
        XCTAssertEqual(TimeText.clock(now.addingTimeInterval(-20 * 3600), now: now, calendar: calendar), "昨天")
        XCTAssertEqual(TimeText.clock(now.addingTimeInterval(-5 * 86400), now: now, calendar: calendar), "10 月 10 日")
        XCTAssertEqual(TimeText.clock(nil, now: now), "")
        XCTAssertEqual(TimeText.duration(since: now.addingTimeInterval(-20), now: now), "刚开始")
        XCTAssertEqual(TimeText.duration(since: now.addingTimeInterval(-120 * 60), now: now), "2 小时")
    }

    func testRejectionTextPrefersMacMessage() {
        var receipt = SyncReceipt(batchId: "b", docId: "d", reviewId: "r", accepted: false, reason: "round-advanced", message: "",
                                  acceptedIds: [], receivedAt: nil)
        XCTAssertEqual(DocumentStore.rejectionText(receipt), "Mac 上已经是新的一轮,这批写在旧一轮上")
        receipt.message = "轮次已推进:这批对应第 2 轮"
        XCTAssertEqual(DocumentStore.rejectionText(receipt), "轮次已推进:这批对应第 2 轮")
    }
}
