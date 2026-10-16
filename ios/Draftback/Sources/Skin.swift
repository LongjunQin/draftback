import SwiftUI
import UIKit

// 方案 C「软皮手账」的手机外观(与 Mac 的 static/desktop-skin.css 同一套,docs/ui-redesign/回稿拟物界面方案.md 第六版):
// 皮面打底,纸卡放在上面;按钮是凸起的米白按钮块;状态用红绿灯指示灯;一律横平竖直;
// 夜读是台灯下的纸(纸变暖变暗、墨还是深色),不是平的黑色。

// MARK: 封面颜色

/// 6 种封面颜色(2026-10-17 用户定:默认淡绿)。皮面从上到下 c1 → c2;浅色皮面上的字用深色。
enum Cover: String, CaseIterable, Identifiable {
    case green, mist, lavender, gold, orange, black
    var id: String { rawValue }
    var name: String {
        switch self {
        case .green: return "淡绿"
        case .mist: return "青雾蓝"
        case .lavender: return "薰衣草紫"
        case .gold: return "浅金"
        case .orange: return "星宇橙"
        case .black: return "深空黑"
        }
    }
    var c1: UInt32 {
        switch self {
        case .green: return 0xD3E2C6
        case .mist: return 0x8BA3B7
        case .lavender: return 0xAB9FC5
        case .gold: return 0xE6D6B6
        case .orange: return 0xE4824A
        case .black: return 0x414145
        }
    }
    var c2: UInt32 {
        switch self {
        case .green: return 0xBFD2B0
        case .mist: return 0x7891A6
        case .lavender: return 0x958AAF
        case .gold: return 0xD3BF98
        case .orange: return 0xCD6A33
        case .black: return 0x2C2C30
        }
    }
    /// 压痕与阴影的颜色
    var shade: UInt32 {
        switch self {
        case .green: return 0x32462A
        case .mist: return 0x142332
        case .lavender: return 0x2D2348
        case .gold: return 0x5C461E
        case .orange: return 0x64280A
        case .black: return 0x000000
        }
    }
    /// 浅色皮面(淡绿、浅金):日间皮面上的字用深色
    var isPale: Bool { self == .green || self == .gold }
    /// 主屏幕图标:淡绿是主图标,其余是备用图标(Assets.xcassets 里的 AppIcon-<封面>)
    var alternateIconName: String? { self == .green ? nil : "AppIcon-\(rawValue)" }

    static let storageKey = "draftback.cover"
    static func stored(_ raw: String) -> Cover { Cover(rawValue: raw) ?? .green }
}

private struct CoverKey: EnvironmentKey { static let defaultValue: Cover = .green }
extension EnvironmentValues {
    var cover: Cover {
        get { self[CoverKey.self] }
        set { self[CoverKey.self] = newValue }
    }
}

/// 外观:跟随系统 / 日间 / 夜读
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "日间"
        case .dark: return "夜读"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
    static let storageKey = "draftback.appearance"
}

// MARK: 颜色

enum Skin {
    /// 夜读时皮面往暖黑里压(台灯照不到的桌面)
    static let nightDim: UInt32 = 0x1C140B

    static func color(_ rgb: UInt32, alpha: Double = 1) -> Color { Color(UIColor(rgb: rgb).withAlphaComponent(alpha)) }
    static func dynamic(_ light: UInt32, _ dark: UInt32, alpha: Double = 1, darkAlpha: Double? = nil) -> Color {
        Color(UIColor { trait in
            trait.userInterfaceStyle == .dark ? UIColor(rgb: dark).withAlphaComponent(darkAlpha ?? alpha) : UIColor(rgb: light).withAlphaComponent(alpha)
        })
    }
    static func mix(_ a: UInt32, _ b: UInt32, _ amount: Double) -> UInt32 {
        func channel(_ v: UInt32, _ shift: UInt32) -> Double { Double((v >> shift) & 0xFF) }
        func blend(_ shift: UInt32) -> UInt32 { UInt32((channel(a, shift) * (1 - amount) + channel(b, shift) * amount).rounded()) }
        return (blend(16) << 16) | (blend(8) << 8) | blend(0)
    }

    // 纸:日间是太阳光下的纸,夜读是台灯下的纸(暖、暗一点)
    static let paper = dynamic(0xFBF8F1, 0xDDCFB3)
    static let card = dynamic(0xFFFDF8, 0xE2D6BC)
    static let band = dynamic(0xF2ECE0, 0xD2C4A6)
    static let tray = dynamic(0xF2ECDF, 0xD0C1A3)
    // 纸上的墨
    static let ink = dynamic(0x2B2620, 0x2A2117)
    static let inkStrong = dynamic(0x221E19, 0x1E170E)
    static let ink2 = dynamic(0x3A342C, 0x3B3124)
    static let muted = dynamic(0x6F6858, 0x5E5141)
    static let rule = dynamic(0x50463A, 0x503C1E, alpha: 0.26, darkAlpha: 0.3)
    static let pen = dynamic(0x34558B, 0x2B4673)
    static let warn = dynamic(0xC0553C, 0xA3412A)
    // 黄便签与荧光笔
    static let note1 = dynamic(0xFFF4BF, 0xEAD88F)
    static let note2 = dynamic(0xF9E9A2, 0xDCC674)
    static let noteQuote = dynamic(0x7A6A3A, 0x6A5A2C)
    static let highlight = dynamic(0xFFD65A, 0xE6B53C)
    // 凸起的米白按钮块
    static let btn1 = dynamic(0xFFFDF8, 0xE6DAC2)
    static let btn2 = dynamic(0xECE5D6, 0xD1C3A6)
    static let btnPress1 = dynamic(0xE3DBCA, 0xC8B99A)
    static let btnPress2 = dynamic(0xF1EBDF, 0xD8CBB0)
    static let btnText = dynamic(0x3D362A, 0x33291C)
    static let btnEdge = dynamic(0x3C2D19, 0x281C0C, alpha: 0.26, darkAlpha: 0.34)
    // 圆贴纸
    static let mint1 = color(0x7FC4A3), mint2 = color(0x5AA984)
    static let coral1 = color(0xF0987E), coral2 = color(0xDE7556)
}

// MARK: 红绿灯指示灯

/// 指示灯按红绿灯(2026-10-17 用户定,与 Mac 一致):绿 = 轮到你,可以动手;黄 = 等着(AI 在改时闪);
/// 红 = 停,出了问题要你处理;灭 = 没在审阅或已结束。未读用蓝点。
enum Light: Equatable {
    case go, wait, stop, off
    var color: Color {
        switch self {
        case .go: return Skin.color(0x34C759)
        case .wait: return Skin.color(0xF5B81C)
        case .stop: return Skin.color(0xE5483B)
        case .off: return Skin.color(0xBDB8AD)
        }
    }
    var dark: Color {
        switch self {
        case .go: return Skin.color(0x1F8F3C)
        case .wait: return Skin.color(0xB07E08)
        case .stop: return Skin.color(0xA82A20)
        case .off: return Skin.color(0x8A857B)
        }
    }
    static let unread = Skin.color(0x2F7CF6)
}

struct IndicatorLight: View {
    var light: Light
    var blinking = false
    var size: CGFloat = 9
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(RadialGradient(stops: [
                .init(color: .white.opacity(light == .off ? 0.55 : 0.9), location: 0),
                .init(color: light.color, location: 0.42),
                .init(color: light.dark, location: 1),
            ], center: UnitPoint(x: 0.35, y: 0.32), startRadius: 0, endRadius: size * 0.72))
            .overlay(Circle().stroke(Color.black.opacity(0.22), lineWidth: 0.6))
            .shadow(color: light == .off ? .clear : light.color.opacity(0.7), radius: size * 0.32)
            .frame(width: size, height: size)
            .opacity(blinking && dim ? 0.3 : 1)
            .onAppear {
                guard blinking, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

/// 未读的蓝点
struct UnreadDot: View {
    var size: CGFloat = 9
    var body: some View {
        Circle().fill(Light.unread).frame(width: size, height: size)
            .shadow(color: Light.unread.opacity(0.35), radius: 2)
            .accessibilityHidden(true)
    }
}

// MARK: 皮面与纸

/// 皮面:颜色由封面决定,上面平铺一层细皮纹(柔光叠加,只改明暗)。deep = 窗口打底那层(比上下栏暗一点)
struct LeatherSurface: View {
    var deep = false
    @Environment(\.cover) private var cover
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let amount = scheme == .dark ? (deep ? 0.64 : 0.56) : (deep ? 0.06 : 0)
        let target: UInt32 = scheme == .dark ? Skin.nightDim : 0x000000
        ZStack {
            LinearGradient(colors: [Skin.color(Skin.mix(cover.c1, target, amount)), Skin.color(Skin.mix(cover.c2, target, amount))],
                           startPoint: .top, endPoint: .bottom)
            Image("LeatherGrain").resizable(resizingMode: .tile).blendMode(.softLight)
            if scheme == .dark && deep {
                // 台灯的光:中间略亮、四周暗
                RadialGradient(colors: [Color(red: 1, green: 0.82, blue: 0.55).opacity(0.1), .clear, .black.opacity(0.28)],
                               center: UnitPoint(x: 0.5, y: 0.35), startRadius: 40, endRadius: 700)
            }
        }
        .compositingGroup()
    }
}

/// 皮面上的字:浅色皮面(日间)用深色字,其余用浅色字
struct LeatherInk {
    let primary: Color
    let secondary: Color
    let shadow: Color
    init(cover: Cover, scheme: ColorScheme) {
        if scheme == .light && cover.isPale {
            let dark = cover == .gold ? Skin.color(0x5E4A28) : Skin.color(0x33402A)
            primary = dark
            secondary = dark.opacity(0.76)
            shadow = Color.white.opacity(0.35)
        } else {
            primary = scheme == .dark ? Color(red: 0.94, green: 0.92, blue: 0.87).opacity(0.94) : Color(red: 0.97, green: 0.98, blue: 0.98)
            secondary = primary.opacity(0.74)
            shadow = Skin.color(cover.shade, alpha: scheme == .dark ? 0.5 : 0.35)
        }
    }
}

/// 纸:底色 + 很淡的纸纤维
struct PaperSurface: View {
    var color: Color = Skin.paper
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ZStack {
            color
            Image(scheme == .dark ? "PaperFiberNight" : "PaperFiber").resizable(resizingMode: .tile)
        }
    }
}

extension View {
    /// 一张放在皮面上的纸卡
    func paperCard(_ color: Color = Skin.card, radius: CGFloat = 6) -> some View {
        modifier(PaperCardModifier(color: color, radius: radius))
    }
}

struct PaperCardModifier: ViewModifier {
    var color: Color
    var radius: CGFloat
    @Environment(\.cover) private var cover
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content
            .background(PaperSurface(color: color).clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous)))
            .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.13), radius: 1, y: 1)
            .shadow(color: scheme == .dark ? .black.opacity(0.4) : Skin.color(cover.shade, alpha: 0.26), radius: 9, y: 6)
    }
}

/// 点线分隔(纸上的横线)
struct DottedRule: View {
    var body: some View {
        Line().stroke(Skin.rule, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [0.1, 4]))
            .frame(height: 1.5)
            .accessibilityHidden(true)
    }
    private struct Line: Shape {
        func path(in rect: CGRect) -> Path { Path { $0.move(to: CGPoint(x: rect.minX, y: rect.midY)); $0.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)) } }
    }
}

// MARK: 按钮

/// 凸起的米白按钮块;按下去陷进去。shape:胶囊、圆角方块或圆
struct RaisedButtonStyle: ButtonStyle {
    enum Shape { case capsule, rounded, circle }
    var shape: Shape = .capsule
    var enabled = true

    func makeBody(configuration: Configuration) -> some View {
        RaisedBody(label: configuration.label, shape: shape, pressed: configuration.isPressed, enabled: enabled)
    }

    private struct RaisedBody<Label: View>: View {
        let label: Label
        let shape: Shape
        let pressed: Bool
        let enabled: Bool
        @Environment(\.cover) private var cover
        @Environment(\.colorScheme) private var scheme

        var body: some View {
            let sunk = pressed || !enabled
            label
                .foregroundStyle(enabled ? Skin.btnText : Skin.muted)
                .background(fill(sunk))
                .overlay(outline)
                .shadow(color: sunk ? .clear : (scheme == .dark ? .black.opacity(0.5) : Skin.color(cover.shade, alpha: 0.45)), radius: 1.5, y: 1.2)
                .contentShape(contentShape)
        }
        @ViewBuilder private func fill(_ sunk: Bool) -> some View {
            let gradient = LinearGradient(colors: sunk ? [Skin.btnPress1, Skin.btnPress2] : [Skin.btn1, Skin.btn2], startPoint: .top, endPoint: .bottom)
            switch shape {
            case .capsule: Capsule().fill(gradient).overlay(Capsule().stroke(Color.white.opacity(sunk ? 0 : 0.8), lineWidth: 1).padding(1).mask(LinearGradient(colors: [.white, .clear], startPoint: .top, endPoint: .center)))
            case .rounded: RoundedRectangle(cornerRadius: 9, style: .continuous).fill(gradient)
            case .circle: Circle().fill(gradient).overlay(Circle().stroke(Color.white.opacity(sunk ? 0 : 0.8), lineWidth: 1).padding(1).mask(LinearGradient(colors: [.white, .clear], startPoint: .top, endPoint: .center)))
            }
        }
        @ViewBuilder private var outline: some View {
            switch shape {
            case .capsule: Capsule().stroke(Skin.btnEdge, lineWidth: 0.75)
            case .rounded: RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Skin.btnEdge, lineWidth: 0.75)
            case .circle: Circle().stroke(Skin.btnEdge, lineWidth: 0.75)
            }
        }
        private var contentShape: AnyShape {
            switch shape {
            case .capsule: return AnyShape(Capsule())
            case .rounded: return AnyShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            case .circle: return AnyShape(Circle())
            }
        }
    }
}

/// 皮面上的圆按钮(返回、大纲、批注、更多、设置、文件夹):一颗米白圆钮
struct RoundIcon: View {
    let systemName: String
    var size: CGFloat = 38
    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.42, weight: .semibold))
            .frame(width: size, height: size)
    }
}

/// 「批注这段」:一截黄色荧光笔
struct HighlighterButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Skin.color(0x4A3A10))
            .background(Capsule().fill(LinearGradient(colors: [Skin.color(0xFFD65A), Skin.color(0xFFE278)], startPoint: .leading, endPoint: .trailing)))
            .overlay(Capsule().stroke(Skin.color(0xC99A1E, alpha: 0.45), lineWidth: 0.75))
            .shadow(color: .black.opacity(configuration.isPressed ? 0 : 0.22), radius: 3, y: 2)
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// 火漆印
struct SealImage: View {
    var size: CGFloat
    var body: some View {
        Image("Seal").resizable().scaledToFit().frame(width: size, height: size)
            .shadow(color: .black.opacity(0.22), radius: 1.5, y: 1.5)
            .accessibilityHidden(true)
    }
}

/// 黄便签(批注):便签自己有胶,平平地贴着;顶上一条略深的胶区
struct StickyNoteBackground: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ZStack(alignment: .top) {
            LinearGradient(colors: [Skin.note1, Skin.note2], startPoint: .top, endPoint: .bottom)
            Image(scheme == .dark ? "PaperFiberNight" : "PaperFiber").resizable(resizingMode: .tile)
            LinearGradient(colors: [Skin.color(0x967814, alpha: 0.1), .clear], startPoint: .top, endPoint: .bottom).frame(height: 9)
        }
        .clipShape(RoundedRectangle(cornerRadius: 2))
        .shadow(color: .black.opacity(0.1), radius: 0.5, y: 1)
        .shadow(color: .black.opacity(scheme == .dark ? 0.3 : 0.14), radius: 5, y: 4)
    }
}

/// 圆贴纸(采纳、未采纳)
struct Sticker: View {
    let text: String
    let applied: Bool
    var body: some View {
        Text(text)
            .font(.caption.weight(.bold)).foregroundStyle(.white)
            .padding(.horizontal, 9).frame(minHeight: 22)
            .background(Capsule().fill(LinearGradient(colors: applied ? [Skin.mint1, Skin.mint2] : [Skin.coral1, Skin.coral2], startPoint: .topLeading, endPoint: .bottomTrailing)))
            .overlay(Capsule().stroke(Skin.card, lineWidth: 2).padding(-1))
            .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
    }
}

// MARK: 开关与分段

/// 开关:关着是压进去的一条槽,开着是一小块皮面
struct LeatherToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Track(isOn: configuration.isOn) { configuration.isOn.toggle() } label: { configuration.label }
    }
    private struct Track<Label: View>: View {
        let isOn: Bool
        let toggle: () -> Void
        @ViewBuilder let label: () -> Label
        @Environment(\.cover) private var cover
        var body: some View {
            HStack {
                label()
                Spacer(minLength: 12)
                ZStack(alignment: isOn ? .trailing : .leading) {
                    Capsule()
                        .fill(isOn ? AnyShapeStyle(LinearGradient(colors: [Skin.color(Skin.mix(cover.c1, 0x000000, cover.isPale ? 0.3 : 0.1)), Skin.color(Skin.mix(cover.c2, 0x000000, cover.isPale ? 0.36 : 0.16))], startPoint: .top, endPoint: .bottom))
                              : AnyShapeStyle(Skin.color(0x786E5F, alpha: 0.22)))
                        .overlay(Capsule().stroke(Color.black.opacity(0.18), lineWidth: 0.75))
                        .frame(width: 52, height: 31)
                    Circle()
                        .fill(LinearGradient(colors: [Skin.btn1, Skin.btn2], startPoint: .top, endPoint: .bottom))
                        .overlay(Circle().stroke(Skin.btnEdge, lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.3), radius: 1.5, y: 1)
                        .frame(width: 27, height: 27)
                        .padding(2)
                }
                .animation(.easeInOut(duration: 0.15), value: isOn)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: toggle)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(isOn ? "开" : "关")
            .accessibilityAction { toggle() }
        }
    }
}

/// 分段选择:压进去的一条,选中的那格是一小片纸
struct PaperSegmented<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value
    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { value, label in
                let on = value == selection
                Button { selection = value } label: {
                    Text(label).font(.subheadline.weight(on ? .semibold : .regular))
                        .foregroundStyle(on ? Skin.ink : Skin.ink2)
                        .padding(.horizontal, 11).frame(minHeight: 30)
                        .background(on ? RoundedRectangle(cornerRadius: 7).fill(Skin.card).shadow(color: .black.opacity(0.2), radius: 1, y: 1) : nil)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 9).fill(Skin.color(0x786E5F, alpha: 0.16)))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.black.opacity(0.08), lineWidth: 0.75))
    }
}

// MARK: 字体

enum SkinFont {
    /// 宋体(随 App 带的思源宋体子集,见 Web/fonts;没有的字落到苹方)
    static func serif(_ size: CGFloat, bold: Bool = false, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(bold ? "NotoSerifSC-Bold" : "NotoSerifSC-Regular", size: size, relativeTo: style)
    }
}

// MARK: 返回手势

/// 上栏是自己画的皮面(隐藏了系统导航栏),系统的左边缘右滑返回要接着能用
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }
    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}
