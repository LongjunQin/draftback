import SwiftUI
import UIKit

/// 设置(方案 C 新加的页面,首页右上角进入):封面颜色、图标跟着封面换、外观、正文字号、iCloud、版本。
/// 「…」菜单里的字号照样留着,和这里是同一个设置。
struct SettingsView: View {
    @EnvironmentObject private var store: DocumentStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.cover) private var cover
    @Environment(\.colorScheme) private var scheme
    @AppStorage(Cover.storageKey) private var coverRaw = Cover.green.rawValue
    @AppStorage(Appearance.storageKey) private var appearanceRaw = Appearance.system.rawValue
    @AppStorage("draftback.iconFollowsCover") private var iconFollowsCover = false
    @AppStorage("draftback.reader.fontStep") private var fontStep = 0
    @State private var message: String?

    private let feedbackURL = URL(string: "https://github.com/LongjunQin/draftback/issues")

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                header
                coverCard
                readingCard
                syncCard
                aboutCard
            }
            .padding(.horizontal, 16).padding(.bottom, 30)
        }
        .background(LeatherSurface(deep: true).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .alert("提示", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("好", role: .cancel) {}
        } message: { Text(message ?? "") }
        .onChange(of: coverRaw) { _, _ in if iconFollowsCover { applyIcon() } }
        .onChange(of: iconFollowsCover) { _, _ in applyIcon() }
    }

    private var leatherInk: LeatherInk { LeatherInk(cover: cover, scheme: scheme) }

    private var header: some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: { RoundIcon(systemName: "chevron.left") }
                .buttonStyle(RaisedButtonStyle(shape: .circle))
                .accessibilityLabel("返回")
            Text("设置")
                .font(SkinFont.serif(28, bold: true, relativeTo: .largeTitle)).kerning(4)
                .foregroundStyle(leatherInk.primary)
                .shadow(color: leatherInk.shadow, radius: 0.5, y: 1)
                .accessibilityAddTraits(.isHeader)
            Spacer()
        }
        .padding(.top, 8)
    }

    private func cardTitle(_ text: String) -> some View {
        Text(text).font(SkinFont.serif(17, bold: true, relativeTo: .headline)).foregroundStyle(Skin.inkStrong)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: 封面颜色

    private var coverCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            cardTitle("封面颜色")
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 6), spacing: 8) {
                ForEach(Cover.allCases) { item in swatch(item) }
            }
            DottedRule()
            Toggle(isOn: $iconFollowsCover) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("图标跟着封面换").font(.body).foregroundStyle(Skin.ink)
                    Text("换的时候 iPhone 会弹出一句提示").font(.footnote).foregroundStyle(Skin.muted)
                }
            }
            .toggleStyle(LeatherToggleStyle())
        }
        .padding(16)
        .paperCard()
    }

    private func swatch(_ item: Cover) -> some View {
        let on = item.rawValue == coverRaw
        return Button { coverRaw = item.rawValue } label: {
            VStack(spacing: 7) {
                ZStack {
                    Circle().fill(LinearGradient(colors: [Skin.color(item.c1), Skin.color(item.c2)], startPoint: .top, endPoint: .bottom))
                    Image("LeatherGrain").resizable(resizingMode: .tile).blendMode(.softLight).clipShape(Circle())
                    if on {
                        Image(systemName: "checkmark").font(.system(size: 15, weight: .bold))
                            .foregroundStyle(item.isPale ? Skin.color(0x3D4A33) : .white)
                    }
                }
                .compositingGroup()
                .frame(width: 42, height: 42)
                .overlay(Circle().stroke(Color.black.opacity(0.15), lineWidth: 0.75))
                .shadow(color: .black.opacity(0.22), radius: 1.5, y: 1)
                .padding(3)
                .overlay(Circle().stroke(on ? Skin.ink : .clear, lineWidth: 2))
                Text(item.name).font(.caption2.weight(on ? .bold : .regular)).foregroundStyle(on ? Skin.ink : Skin.ink2)
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.name)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    /// 图标跟着封面换:主图标是淡绿,其余 5 种是备用图标;iPhone 换图标时会弹出系统提示(苹果的规定)
    private func applyIcon() {
        guard UIApplication.shared.supportsAlternateIcons else { return }
        let wanted = iconFollowsCover ? Cover.stored(coverRaw).alternateIconName : nil
        guard UIApplication.shared.alternateIconName != wanted else { return }
        UIApplication.shared.setAlternateIconName(wanted) { error in
            if let error { DispatchQueue.main.async { message = "没能换图标:\(error.localizedDescription)" } }
        }
    }

    // MARK: 阅读

    private var readingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            cardTitle("阅读")
            HStack {
                Text("外观").foregroundStyle(Skin.ink)
                Spacer(minLength: 8)
                PaperSegmented(options: Appearance.allCases.map { ($0.rawValue, $0.label) }, selection: $appearanceRaw)
            }
            DottedRule()
            HStack {
                Text("正文字号").foregroundStyle(Skin.ink)
                Spacer(minLength: 8)
                PaperSegmented(options: [(0, "默认"), (1, "大"), (2, "特大")], selection: $fontStep)
            }
            Text("夜读是台灯下的纸:纸暖一点、暗一点,字还是深色。").font(.footnote).foregroundStyle(Skin.muted)
        }
        .padding(16)
        .paperCard()
    }

    // MARK: 同步

    private var syncCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            cardTitle("同步")
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } label: {
                HStack(spacing: 12) {
                    IndicatorLight(light: syncLight)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(syncLine).foregroundStyle(Skin.ink).lineLimit(2)
                        Text("Apple ID 要和 Mac 上的一样").font(.footnote).foregroundStyle(Skin.muted)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Skin.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("打开系统设置")
        }
        .padding(16)
        .paperCard()
    }

    private var syncLight: Light {
        if store.cloudAccount == .noAccount || store.syncError != nil { return .stop }
        if store.syncing && store.lastPullAt == nil { return .wait }
        return store.lastPullAt == nil ? .off : .go
    }

    private var syncLine: String {
        if store.cloudAccount == .noAccount { return "未登录 iCloud" }
        if let error = store.syncError { return error }
        if store.syncing && store.lastPullAt == nil { return "正在同步…" }
        if let date = store.lastPullAt { return "iCloud 已同步 · \(TimeText.clock(date))" }
        return "iCloud"
    }

    // MARK: 关于

    private var aboutCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            cardTitle("关于")
            HStack {
                Text("版本").foregroundStyle(Skin.ink)
                Spacer()
                Text(versionText).foregroundStyle(Skin.muted).monospacedDigit()
            }
            if let feedbackURL {
                DottedRule()
                Button { UIApplication.shared.open(feedbackURL) } label: {
                    HStack {
                        Text("反馈问题").foregroundStyle(Skin.ink)
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Skin.muted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(16)
        .paperCard()
    }

    private var versionText: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        return build.isEmpty ? short : "\(short)(\(build))"
    }
}
