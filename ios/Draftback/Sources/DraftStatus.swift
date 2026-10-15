import Foundation

/// 首页分组,规则与 Mac 左栏一致(static/desktop-drafts.js),说法也一致(一词一义):
///   轮到你  可批注、文件被别的程序改了、稿子回来了、已通过、已恢复
///   已交出  三档:还没有 AI 接入 / AI 在线,等待领取 / AI 正在修改;我自己改(在 Mac 上)
///   已结束  已定稿、已作废(Mac 上放在「最近打开」)
/// 手机独有的「本机文件」没有轮次,不在这里。
enum DraftGroup: String, CaseIterable, Identifiable {
    case yours, handed, ended
    var id: String { rawValue }
    var title: String {
        switch self {
        case .yours: return "轮到你"
        case .handed: return "已交出"
        case .ended: return "已结束"
        }
    }
}

struct DraftRowState: Equatable {
    var group: DraftGroup
    var tone: Tone
    var subtitle: String
    /// AI 正在修改:行尾一个慢转的小圈
    var spinning = false
    /// 稿子回来了还没看:行尾蓝点
    var unread = false
    /// 新的一轮推过来、还没在手机上打开过:「新」
    var isNew = false
    /// 读屏用的说法(颜色与圆点都要有文字)
    var spoken: String
}

enum DraftStatus {
    /// 手机上记的「看过」:会话标识 + 状态。换了一轮或状态变了就算没看过。
    static func seenKey(for doc: SyncedDocument) -> String { "\(doc.reviewId)|\(doc.phoneState)" }

    /// seen:上次在手机上看到时记下的 seenKey;localOpen:手机上这一轮还没交的批注数
    static func row(for doc: SyncedDocument, seen: String?, localOpen: Int = 0, now: Date = Date()) -> DraftRowState {
        let round = "第 \(doc.round) 轮"
        let when = TimeText.clock(doc.pushedAt, now: now)
        let stamp = when.isEmpty ? "" : " · \(when)"
        switch doc.phoneState {
        case "reviewing":
            let openedThisRound = seen?.hasPrefix(doc.reviewId + "|") ?? false
            let pending = localOpen > 0 ? "\(localOpen) 条未交" : "可批注"
            return DraftRowState(group: .yours, tone: .turn, subtitle: "\(round) · \(pending)\(stamp)", isNew: !openedThisRound,
                                 spoken: "\(round),\(pending)\(openedThisRound ? "" : ",新")")
        case "conflict":
            return DraftRowState(group: .yours, tone: .conflict, subtitle: "文件被别的程序改了 · 要在 Mac 上处理",
                                 spoken: "文件被别的程序改了,要在 Mac 上处理")
        case "waiting-agent":
            switch doc.agentState {
            case "claimed":
                return DraftRowState(group: .handed, tone: .ai, subtitle: "AI 正在修改 · \(TimeText.duration(since: doc.pushedAt, now: now))",
                                     spinning: true, spoken: "AI 正在修改")
            case "listening":
                return DraftRowState(group: .handed, tone: .waiting, subtitle: "已交出 · AI 在线,等待领取", spoken: "已交出,AI 在线,等待领取")
            case "none":
                return DraftRowState(group: .handed, tone: .waiting, subtitle: "已交出 · 还没有 AI 接入\(stamp)", spoken: "已交出,还没有 AI 接入")
            default:
                // 旧版 Mac 不推三档:不猜有没有 AI 接入
                return DraftRowState(group: .handed, tone: .waiting, subtitle: "已交出\(stamp)", spoken: "已交出")
            }
        case "applying":
            return DraftRowState(group: .handed, tone: .ai, subtitle: "AI 正在修改 · \(TimeText.duration(since: doc.pushedAt, now: now))",
                                 spinning: true, spoken: "AI 正在修改")
        case "manual-editing":
            return DraftRowState(group: .handed, tone: .turn, subtitle: "我自己改 · 在 Mac 上\(stamp)", spoken: "我在 Mac 上自己改")
        case "completed":
            if doc.outcome == "approved" {
                return DraftRowState(group: .yours, tone: .back, subtitle: "\(round) · 已通过,没有批注\(stamp)", spoken: "\(round)已通过,没有批注")
            }
            let unread = seen != "\(doc.reviewId)|completed"
            return DraftRowState(group: .yours, tone: .back, subtitle: "\(round)回稿\(stamp)", unread: unread,
                                 spoken: "\(round)回稿\(unread ? ",还没看" : "")")
        case "restored":
            return DraftRowState(group: .yours, tone: .back, subtitle: "\(round) · 已恢复到改稿前\(stamp)", spoken: "\(round),已恢复到改稿前")
        case "finalized":
            return DraftRowState(group: .ended, tone: .done, subtitle: "已定稿\(stamp)", spoken: "已定稿")
        case "cancelled":
            return DraftRowState(group: .ended, tone: .idle, subtitle: "已作废\(stamp)", spoken: "本轮已作废")
        default:
            return DraftRowState(group: .ended, tone: .idle, subtitle: "Mac 上的状态手机还不认识,请更新回稿", spoken: "未知状态")
        }
    }
}

/// 读稿页上的状态:导航栏副标题、正文上方横幅、底栏左槽(状态两行)、右槽主按钮,以及这会儿能不能批注。
/// 跨端规则第 7 节:每一步都由真实事件推进(本地已保存 → 等待同步 → Mac 已收到 → AI 领取 → 稿子回来),界面不凭猜测前进。
struct ReaderStatus: Equatable {
    struct Banner: Equatable {
        var text: String
        var tone: Tone
        var spinning = false
        /// 横幅右侧的按钮(如「换成新版」)
        var action: BannerAction?
    }
    enum BannerAction: Equatable { case loadNewVersion }
    enum Primary: Equatable {
        case handOff(Int)        // 交给 AI · k
        case handOffDisabled     // 交给 AI(还没有批注)
        case handedOff           // 已交出(不能点)
        case busy                // 改稿中…(不能点,与 Mac 的主按钮一致)
        case resend              // 重新发送(久等没回执)
        case exportBatch(Int)    // 导出批注 · k(手机独立打开的文件)
        case reexport            // 重新导出
    }
    enum StatusTap: Equatable { case openNotes }

    var subtitle: String
    var subtitleTone: Tone
    var banner: Banner?
    var statusLine: String
    var statusDetail: String?
    var statusTap: StatusTap?
    var primary: Primary?
    /// 选中文字后能不能写批注(底栏「批注这段」、系统菜单「批注」、写总体意见都看它)
    var canAnnotate: Bool
    /// 不能批注时的说明
    var blockedReason: String?

    struct Inputs: Equatable {
        var sync: SyncedDocument?
        var annotationAllowed: Bool
        var newerVersionAvailable: Bool
        var latestRound: Int?
        var open = 0, submitted = 0, received = 0, rejected = 0
        var pendingUploads = 0
        var oldestSubmittedAt: Date?
        var now = Date()
    }

    /// 交出后多久没回执就提示「等待 Mac 在线」并给「重新发送」
    static let receiptPatience: TimeInterval = 180

    static func make(_ input: Inputs) -> ReaderStatus {
        guard let sync = input.sync else { return local(input) }
        var status = synced(sync, input)
        if input.newerVersionAvailable {
            let round = input.latestRound.map { "第 \($0) 轮" } ?? ""
            status.banner = Banner(text: "Mac 推来了\(round)新版", tone: .turn, action: .loadNewVersion)
        }
        return status
    }

    private static func local(_ input: Inputs) -> ReaderStatus {
        if input.submitted > 0 && input.open == 0 {
            return ReaderStatus(subtitle: "本机文件", subtitleTone: .idle, statusLine: "已导出 \(input.submitted) 条", statusDetail: "在 Mac 上导入成新批注",
                                statusTap: .openNotes, primary: .reexport, canAnnotate: true)
        }
        if input.open > 0 {
            return ReaderStatus(subtitle: "本机文件", subtitleTone: .idle, statusLine: "本地已保存 \(input.open) 条", statusDetail: "选中文字就能批注",
                                statusTap: .openNotes, primary: .exportBatch(input.open), canAnnotate: true)
        }
        return ReaderStatus(subtitle: "本机文件", subtitleTone: .idle, statusLine: "手机批注", statusDetail: "选中文字就能批注", canAnnotate: true)
    }

    private static func synced(_ sync: SyncedDocument, _ input: Inputs) -> ReaderStatus {
        let round = "第 \(sync.round) 轮"
        let handedNote = "这一轮已交给 AI。稿子回来后再批注。"
        switch sync.phoneState {
        case "reviewing":
            let subtitle = "\(round) · 可批注"
            if input.submitted > 0 {
                if input.pendingUploads > 0 {
                    return ReaderStatus(subtitle: subtitle, subtitleTone: .turn, statusLine: "等待同步 \(input.submitted) 条", statusDetail: "联网后自动上传",
                                        statusTap: .openNotes, primary: .handedOff, canAnnotate: false, blockedReason: handedNote)
                }
                let waitedLong = input.oldestSubmittedAt.map { input.now.timeIntervalSince($0) > receiptPatience } ?? false
                return ReaderStatus(subtitle: subtitle, subtitleTone: .turn, statusLine: "已交出 \(input.submitted) 条",
                                    statusDetail: waitedLong ? "等待 Mac 在线" : "等待 Mac 收到", statusTap: .openNotes,
                                    primary: waitedLong ? .resend : .handedOff, canAnnotate: false, blockedReason: handedNote)
            }
            if input.received > 0 {
                return ReaderStatus(subtitle: subtitle, subtitleTone: .turn, statusLine: "Mac 已收到 \(input.received) 条", statusDetail: "等待 AI 开始修改",
                                    statusTap: .openNotes, primary: .handedOff, canAnnotate: false, blockedReason: handedNote)
            }
            if !input.annotationAllowed {
                return ReaderStatus(subtitle: subtitle, subtitleTone: .turn, statusLine: "正文还在同步", statusDetail: "同步完成后才能批注",
                                    canAnnotate: false, blockedReason: "正文还不是这一轮的。同步完成后才能批注。")
            }
            if input.open > 0 {
                return ReaderStatus(subtitle: subtitle, subtitleTone: .turn, statusLine: "本地已保存 \(input.open) 条", statusDetail: "选中文字就能批注",
                                    statusTap: .openNotes, primary: .handOff(input.open), canAnnotate: true)
            }
            if input.rejected > 0 {
                return ReaderStatus(subtitle: subtitle, subtitleTone: .turn, statusLine: "\(input.rejected) 条被 Mac 拒收", statusDetail: "点这里看原因",
                                    statusTap: .openNotes, primary: .handOffDisabled, canAnnotate: true)
            }
            return ReaderStatus(subtitle: subtitle, subtitleTone: .turn, statusLine: "\(round) · 可批注", statusDetail: "选中文字就能批注",
                                primary: .handOffDisabled, canAnnotate: true)
        case "waiting-agent":
            // 副标题已经说了「已交出」,横幅只说三档里的哪一档
            if sync.agentState == "claimed" {
                return ReaderStatus(subtitle: "AI 正在修改", subtitleTone: .ai, banner: Banner(text: "AI 正在修改,改完会自动换成新版", tone: .ai, spinning: true),
                                    statusLine: receivedLine(input), statusDetail: nil, statusTap: input.received > 0 ? .openNotes : nil,
                                    primary: .busy, canAnnotate: false, blockedReason: handedNote)
            }
            // 旧版 Mac 不推三档(agentState 为空):不出横幅,不猜有没有 AI 接入
            let banner: Banner? = sync.agentState == "listening" ? Banner(text: "AI 在线,等待领取", tone: .waiting)
                : sync.agentState == "none" ? Banner(text: "还没有 AI 接入", tone: .waiting) : nil
            return ReaderStatus(subtitle: "已交出", subtitleTone: .waiting, banner: banner, statusLine: receivedLine(input),
                                statusDetail: "稿子回来会自动换成新版", statusTap: input.received + input.rejected > 0 ? .openNotes : nil,
                                primary: .handedOff, canAnnotate: false, blockedReason: handedNote)
        case "applying":
            return ReaderStatus(subtitle: "AI 正在修改", subtitleTone: .ai, banner: Banner(text: "AI 正在修改,改完会自动换成新版", tone: .ai, spinning: true),
                                statusLine: receivedLine(input), statusDetail: nil, statusTap: input.received > 0 ? .openNotes : nil,
                                primary: .busy, canAnnotate: false, blockedReason: handedNote)
        case "manual-editing":
            return ReaderStatus(subtitle: "我自己改", subtitleTone: .turn, banner: Banner(text: "你在 Mac 上自己改,改完会自动换成新版", tone: .turn),
                                statusLine: "在 Mac 上自己改", statusDetail: "改完会自动换成新版", canAnnotate: false,
                                blockedReason: "这一轮在 Mac 上自己改。改完后再批注。")
        case "completed":
            if sync.outcome == "approved" {
                return ReaderStatus(subtitle: "\(round) · 已通过", subtitleTone: .back, statusLine: "已通过 · 没有批注", statusDetail: "要接着改,在 Mac 上开下一轮",
                                    canAnnotate: false, blockedReason: "这一轮已通过。要接着改,先在 Mac 上开下一轮。")
            }
            return ReaderStatus(subtitle: "\(round)回稿", subtitleTone: .back, statusLine: "稿子回来了",
                                statusDetail: "要接着改,在 Mac 上开下一轮",
                                canAnnotate: false, blockedReason: "稿子回来了。要接着改,先在 Mac 上开下一轮。")
        case "restored":
            return ReaderStatus(subtitle: "已恢复到改稿前", subtitleTone: .back, statusLine: "已恢复到\(round)改稿前", statusDetail: "要接着改,在 Mac 上开下一轮",
                                canAnnotate: false, blockedReason: "正文已恢复到改稿前。要接着改,先在 Mac 上开下一轮。")
        case "finalized":
            return ReaderStatus(subtitle: "已定稿", subtitleTone: .done, statusLine: "这篇已定稿", statusDetail: nil,
                                canAnnotate: false, blockedReason: "这篇已定稿。")
        case "cancelled":
            return ReaderStatus(subtitle: "本轮已作废", subtitleTone: .idle, statusLine: "本轮已作废", statusDetail: "要接着改,在 Mac 上开下一轮",
                                canAnnotate: false, blockedReason: "这一轮已作废。")
        case "conflict":
            let rejected = input.rejected > 0
            return ReaderStatus(subtitle: "文件被改了", subtitleTone: .conflict,
                                banner: Banner(text: "文件在 Mac 上被别的程序改了,要在 Mac 上处理", tone: .conflict),
                                statusLine: rejected ? "\(input.rejected) 条被 Mac 拒收" : "等你在 Mac 上处理",
                                statusDetail: rejected ? "点这里看原因" : "处理完这里会自动更新", statusTap: rejected ? .openNotes : nil,
                                canAnnotate: false, blockedReason: "文件在 Mac 上被别的程序改了。在 Mac 上处理完才能批注。")
        default:
            return ReaderStatus(subtitle: "未知状态", subtitleTone: .idle, statusLine: "手机还不认识这个状态", statusDetail: "请更新回稿",
                                canAnnotate: false, blockedReason: "手机还不认识这篇的状态,请更新回稿。")
        }
    }

    private static func receivedLine(_ input: Inputs) -> String {
        if input.received > 0 { return "Mac 已收到 \(input.received) 条" }
        if input.submitted > 0 { return "已交出 \(input.submitted) 条" }
        return "这一轮在 Mac 上交出"
    }
}
