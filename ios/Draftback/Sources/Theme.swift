import SwiftUI
import UIKit

/// 稿子走到哪了(语义);颜色按红绿灯(2026-10-17 用户定,与 Mac 一致,见 Skin.swift 的 Light):
/// 轮到你 / 回稿了 = 绿灯;等着(已交出、AI 在改)= 黄灯;出了问题 = 红灯;结束了 / 本机文件 = 灯灭。
enum Tone: Equatable {
    case turn       // 轮到你 / 可批注 / 自己改
    case waiting    // 已交出,等 Mac / 等 AI
    case ai         // AI 正在改稿
    case back       // 回稿了 / 已通过 / 已恢复
    case done       // 已定稿
    case conflict   // 原文被改过
    case idle       // 已作废 / 本机文件

    var light: Light {
        switch self {
        case .turn, .back: return .go
        case .waiting, .ai: return .wait
        case .conflict: return .stop
        case .done, .idle: return .off
        }
    }
    /// 指示灯的颜色
    var color: Color { light.color }
    /// 横幅纸条的底色(纸上淡淡带一点灯的颜色)
    var soft: Color {
        switch light {
        case .go: return Skin.dynamic(0xEAF2E2, 0xCCCB9F)
        case .wait: return Skin.dynamic(0xFBF1D4, 0xDDC68F)
        case .stop: return Skin.dynamic(0xFBE6DD, 0xDAB49B)
        case .off: return Skin.dynamic(0xF0EBE1, 0xD0C2A4)
        }
    }
    /// 横幅与副标题上的字:出问题用红墨,其余用纸上的墨
    var text: Color { light == .stop ? Skin.warn : Skin.ink }
}

enum Palette {
    static let amber = dynamic(0xF59A23, 0xF0A43A)
    static let amberText = dynamic(0xC56D00, 0xF2B45A)
    static let amberSoft = dynamic(0xFFF8E8, 0x332A16)
    static let unread = Light.unread
    /// 阅读页纸面底色(与 Web/reader.css 的 --paper 一致):日间太阳光下的纸,夜读台灯下的纸
    static let paper = Skin.paper

    static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { trait in UIColor(rgb: trait.userInterfaceStyle == .dark ? dark : light) })
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

/// 时间的说法与 Mac 左栏一致(static/desktop-drafts.js 的 clock / duration)。
enum TimeText {
    static func clock(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date else { return "" }
        let diff = now.timeIntervalSince(date)
        if diff >= 0 && diff < 60 { return "刚刚" }
        if diff >= 0 && diff < 3600 { return "\(max(1, Int((diff / 60).rounded()))) 分钟前" }
        if calendar.isDate(date, inSameDayAs: now) {
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            formatter.dateFormat = "HH:mm"
            return formatter.string(from: date)
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "昨天" }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        if parts.year == calendar.component(.year, from: now) { return "\(parts.month ?? 1) 月 \(parts.day ?? 1) 日" }
        return "\(parts.year ?? 0)/\(parts.month ?? 1)/\(parts.day ?? 1)"
    }

    static func duration(since date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        let minutes = max(0, Int((now.timeIntervalSince(date) / 60).rounded()))
        if minutes < 1 { return "刚开始" }
        if minutes < 60 { return "\(minutes) 分钟" }
        return minutes % 60 == 0 ? "\(minutes / 60) 小时" : "\(minutes / 60) 小时 \(minutes % 60) 分"
    }
}
