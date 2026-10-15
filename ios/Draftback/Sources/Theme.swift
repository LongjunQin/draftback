import SwiftUI
import UIKit

/// 与 Mac 同一套语义色(static/desktop.css):批注琥珀、轮到你青绿、等待灰蓝、AI 紫、回稿绿、冲突红、结束灰、未读蓝。
/// 琥珀只给批注;状态色只表示"走到哪了"。浅色、深色各一套。
enum Tone: Equatable {
    case turn       // 轮到你 / 可批注 / 自己改
    case waiting    // 已交出,等 Mac / 等 AI
    case ai         // AI 正在改稿
    case back       // 回稿了 / 已通过 / 已恢复
    case done       // 已定稿
    case conflict   // 原文被改过
    case idle       // 已作废 / 本机文件

    var color: Color {
        switch self {
        case .turn: return Palette.dynamic(0x0D8077, 0x3FC1B2)
        case .waiting: return Palette.dynamic(0x64748B, 0x94A3B8)
        case .ai: return Palette.dynamic(0x6E56CF, 0x9E8CFC)
        case .back: return Palette.dynamic(0x229453, 0x3FBF72)
        case .done: return Palette.dynamic(0x6B8F78, 0x5E8A6E)
        case .conflict: return Palette.dynamic(0xCC3E3E, 0xE46B6B)
        case .idle: return Palette.dynamic(0x8D96A6, 0x7C8594)
        }
    }
    /// 横幅底色
    var soft: Color {
        switch self {
        case .turn: return Palette.dynamic(0xECF7F5, 0x16302C)
        case .waiting: return Palette.dynamic(0xEEF1F5, 0x2A2F38)
        case .ai: return Palette.dynamic(0xEFEBFB, 0x2A2547)
        case .back, .done: return Palette.dynamic(0xEAF8EF, 0x17301F)
        case .conflict: return Palette.dynamic(0xFFF0EF, 0x3A1F1F)
        case .idle: return Palette.dynamic(0xF1F3F6, 0x2A2E36)
        }
    }
    /// 横幅与副标题上的文字色(在浅底上过 4.5:1)
    var text: Color {
        switch self {
        case .turn: return Palette.dynamic(0x0A665E, 0x7FD8CC)
        case .waiting: return Palette.dynamic(0x475569, 0xC1CAD6)
        case .ai: return Palette.dynamic(0x5B44B8, 0xC4B8FF)
        case .back, .done: return Palette.dynamic(0x237445, 0x8FDCAC)
        case .conflict: return Palette.dynamic(0x9B302D, 0xF1A0A0)
        case .idle: return Palette.dynamic(0x5B6575, 0xAEB6C2)
        }
    }
}

enum Palette {
    static let amber = dynamic(0xF59A23, 0xF0A43A)
    static let amberText = dynamic(0xC56D00, 0xF2B45A)
    static let amberSoft = dynamic(0xFFF8E8, 0x332A16)
    static let unread = dynamic(0x2F6FDE, 0x6C9CFF)
    /// 阅读页纸面底色(与 Web/reader.css 的 --paper 一致):状态栏、底部横条那两块也铺这个颜色,不留黑边
    static let paper = dynamic(0xFFFDF8, 0x1F2126)

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
