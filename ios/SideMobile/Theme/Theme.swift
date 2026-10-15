import SwiftUI

/// The IDE's theme (src/styles/index.css, host/webapp/styles.css): one dark
/// background, one content colour, and every stroke or fill mixed from it.
enum Theme {
    static let bg = Color(white: 0.09)
    static let text = Color(white: 0.92)
    static let muted = text.opacity(0.5)
    static let faint = text.opacity(0.35)
    static let stroke = text.opacity(0.07)
    static let strokeStrong = text.opacity(0.12)
    static let fillSubtle = text.opacity(0.08)
    static let fill = text.opacity(0.10)
    static let fillHover = text.opacity(0.15)
    /// The sidebar: the background with a little of the content mixed in.
    static let sidebar = Color(white: 0.157)
    static let accent = Color(hue: 211 / 360, saturation: 0.92, lightness: 0.62)
    static let link = Color(hex: 0x7DD3FC)
    static let heading = Color(hex: 0xF9A8C9)
    static let add = Color(hex: 0x10B981)
    static let addFg = Color(hex: 0x6EE7B7)
    static let del = Color(hex: 0xF43F5E)
    static let delFg = Color(hex: 0xFDA4AF)
    static let amber = Color(hex: 0xFBBF24)

    static let body = Font.system(size: 15)
    static let small = Font.system(size: 13)
    static let meta = Font.system(size: 12)
    static let mono = Font.system(size: 12, design: .monospaced)
    static let monoSmall = Font.system(size: 11, design: .monospaced)

    /// The rail's project colours (src/features/workspace/model/tabGroups.ts).
    static let projectColors: [Color] = [
        Color(hue: 210 / 360, saturation: 0.08, lightness: 0.58),
        Color(hue: 211 / 360, saturation: 0.92, lightness: 0.62),
        Color(hue: 12 / 360, saturation: 0.80, lightness: 0.58),
        Color(hue: 45 / 360, saturation: 0.90, lightness: 0.55),
        Color(hue: 142 / 360, saturation: 0.55, lightness: 0.50),
        Color(hue: 330 / 360, saturation: 0.70, lightness: 0.62),
        Color(hue: 280 / 360, saturation: 0.55, lightness: 0.62),
        Color(hue: 175 / 360, saturation: 0.55, lightness: 0.48),
        Color(hue: 25 / 360, saturation: 0.85, lightness: 0.58),
    ]

    /// As `tabGroupColor`: a folder name always gets the same colour.
    static func projectColor(_ name: String) -> Color {
        var hash: UInt32 = 0
        for unit in name.utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return projectColors[Int(hash % UInt32(projectColors.count - 1)) + 1]
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    init(hue: Double, saturation: Double, lightness: Double) {
        let c = (1 - abs(2 * lightness - 1)) * saturation
        let h = hue * 6
        let x = c * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1))
        let (r, g, b): (Double, Double, Double) = switch h {
        case ..<1: (c, x, 0)
        case ..<2: (x, c, 0)
        case ..<3: (0, c, x)
        case ..<4: (0, x, c)
        case ..<5: (x, 0, c)
        default: (c, 0, x)
        }
        let m = lightness - c / 2
        self.init(red: r + m, green: g + m, blue: b + m)
    }

    /// `hsl(211 92% 62%)` or `#rrggbb`, as a Mono's colour is stored.
    init?(css: String) {
        let value = css.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("#"), value.count == 7, let hex = UInt32(value.dropFirst(), radix: 16) {
            self.init(hex: hex)
            return
        }
        guard let match = value.firstMatch(of: #/hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)/#),
              let h = Double(match.1), let s = Double(match.2), let l = Double(match.3) else { return nil }
        self.init(hue: h / 360, saturation: s / 100, lightness: l / 100)
    }
}

/// The desktop's 8×8 pixel mascot for a project, in its colour; its two
/// frames alternate while the project has a turn running.
struct MascotView: View {
    let seed: String
    /// A mascot picked by name (a colleague's), instead of hashed from the seed.
    var name: String?
    var color: Color?
    var active = false
    var size: CGFloat = 14

    private var mascot: (name: String, rest: [String], talk: [String]) {
        if let name, let chosen = projectMascots.first(where: { $0.name == name }) { return chosen }
        var hash: UInt32 = 0
        for unit in seed.utf16 { hash = hash &* 131 &+ UInt32(unit) }
        return projectMascots[Int(hash % UInt32(projectMascots.count))]
    }

    var body: some View {
        if active {
            TimelineView(.periodic(from: .now, by: 0.35)) { context in
                let frame = Int(context.date.timeIntervalSinceReferenceDate / 0.35) % 2
                grid(frame == 0 ? mascot.rest : mascot.talk)
            }
        } else {
            grid(mascot.rest)
        }
    }

    private func grid(_ rows: [String]) -> some View {
        Canvas { context, size in
            let cell = size.width / 8
            for (y, row) in rows.enumerated() {
                for (x, char) in row.enumerated() where char == "#" {
                    context.fill(Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)), with: .color(color ?? Theme.projectColor(seed)))
                }
            }
        }
        .frame(width: size, height: size)
    }
}

/// The agent's logo, as the desktop's `HarnessIcon` draws it.
struct HarnessIcon: View {
    let harness: String
    var size: CGFloat = 14

    var body: some View {
        if UIImage(named: "harness-\(harness)") != nil {
            Image("harness-\(harness)")
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(Theme.text)
        } else {
            Text(harness.prefix(1).uppercased())
                .font(.system(size: size * 0.7, weight: .bold, design: .monospaced))
                .frame(width: size, height: size)
                .foregroundStyle(Theme.muted)
        }
    }
}

/// A small rounded label: "Needs you", "Interrupted".
struct Pill: View {
    let text: String
    var color: Color = Theme.amber

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: .capsule)
    }
}

/// The section labels of the sidebar: small, muted, uppercase.
struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 6)
    }
}

/// A shimmer over text while something runs, as the desktop's `.shimmer`.
struct Shimmer: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            TimelineView(.animation) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                content.overlay {
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: phase - 0.25),
                            .init(color: Theme.bg.opacity(0.65), location: phase),
                            .init(color: .clear, location: phase + 0.25),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .mask(content)
                    .allowsHitTesting(false)
                }
            }
        } else {
            content
        }
    }
}

extension View {
    func shimmer(_ active: Bool) -> some View { modifier(Shimmer(active: active)) }

    /// The desktop's cards: a faint fill and a hairline.
    func card(padding: CGFloat = 12, radius: CGFloat = 10) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.fillSubtle.opacity(0.6), in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.stroke))
    }
}

/// The button looks of the web app: quiet by default, accent when primary.
struct ThemeButtonStyle: ButtonStyle {
    var primary = false
    var danger = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(primary ? Color.white : danger ? Theme.delFg : Theme.text)
            .background(primary ? Theme.accent : Theme.fill, in: .rect(cornerRadius: 7))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Relative time as the sidebar shows it: "now", "5m", "3h", "2d".
func ago(_ ms: Double) -> String {
    let seconds = max(0, Date().timeIntervalSince1970 - ms / 1000)
    if seconds < 60 { return "now" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86400 { return "\(Int(seconds / 3600))h" }
    if seconds < 86400 * 30 { return "\(Int(seconds / 86400))d" }
    return "\(Int(seconds / (86400 * 30)))mo"
}

/// A home-relative path, as the desktop shows a working copy.
func tilde(_ path: String) -> String {
    path.replacing(/^\/(Users|home)\/[^\/]+/, with: "~")
}

func folderName(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
}
