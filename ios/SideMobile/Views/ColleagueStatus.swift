import SwiftUI

/// What a colleague is doing on its desktop, as a dot and a short line.
struct ColleagueStatusLine: View {
    let state: ColleagueAccounts.State?
    var fallback: String = ""

    var body: some View {
        HStack(spacing: 5) {
            if let state, state.status != "idle" {
                Circle().fill(color(state.status)).frame(width: 6, height: 6)
                Text([label(state.status), state.activity].compactMap { $0 }.joined(separator: " · "))
                    .foregroundStyle(color(state.status))
            } else {
                Text(fallback)
            }
        }
        .lineLimit(1)
    }

    private func label(_ status: String) -> String {
        status == "working" ? "Working" : "Needs you"
    }

    private func color(_ status: String) -> Color {
        status == "working" ? Theme.link : Theme.amber
    }
}

/// How much of a plan window is left and when it starts over: `18% 56m`.
private func remaining(_ window: ColleagueAccounts.Window?) -> String? {
    guard let window else { return nil }
    let left = "\(Int(max(0, 100 - window.used).rounded()))%"
    guard let reset = window.resetsAt.map(resetsIn) else { return left }
    return "\(left) \(reset)"
}

/// `100% 5h · 40% 7d`: what is left of each window, as the desktop's menu.
private func windowsLeft(_ usage: ColleagueAccounts.Usage) -> String {
    [usage.session.map { "\(Int(max(0, 100 - $0.used).rounded()))% 5h" },
     usage.weekly.map { "\(Int(max(0, 100 - $0.used).rounded()))% 7d" }]
        .compactMap { $0 }
        .joined(separator: " · ")
}

/// `56m`, `3h`, `2d`: the time until a window starts over.
func resetsIn(_ at: Double) -> String {
    let seconds = max(0, at / 1000 - Date().timeIntervalSince1970)
    if seconds < 3600 { return "\(max(1, Int((seconds / 60).rounded(.up))))m" }
    if seconds < 86_400 { return "\(Int((seconds / 3600).rounded()))h" }
    return "\(Int((seconds / 86_400).rounded()))d"
}

private func windowColor(_ used: Double) -> Color {
    used >= 90 ? Theme.del : used >= 75 ? Theme.amber : Theme.muted
}

/// The share of a window left, 0 to 1, which the bars fill, as the desktop's.
private func left(_ used: Double) -> Double { min(1, max(0, (100 - used) / 100)) }

/// The usage chip under a colleague's composer, as the desktop's: the
/// account's 5-hour window as a bar, then both windows left. Opens the detail.
struct UsageStrip: View {
    let provider: String
    let usage: ColleagueAccounts.Usage?
    var balanced = false
    var pending: String?
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                HarnessIcon(harness: provider, size: 12)
                if balanced && pending == nil { Text("Balanced").foregroundStyle(Theme.faint) }
                if let pending {
                    Text("→ \(pending)…").foregroundStyle(Theme.muted)
                } else if let usage {
                    let used = usage.session?.used ?? 0
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.fill)
                        Capsule().fill(windowColor(used)).frame(width: 28 * left(used))
                    }
                    .frame(width: 28, height: 4)
                    Text([remaining(usage.session), remaining(usage.weekly)].compactMap { $0 }.joined(separator: " · "))
                        .foregroundStyle(Theme.muted)
                } else {
                    Text("Usage").foregroundStyle(Theme.muted)
                }
            }
            .font(.system(size: 11.5).monospacedDigit())
            .padding(.horizontal, 7)
            .frame(height: 26)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.stroke))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// A colleague's plan usage and the accounts it can move to, as the
/// desktop's usage popover.
struct UsageSheet: View {
    /// What the phone sends to turn Balanced on, as the desktop reads it.
    static let balancedId = "auto"

    let accounts: [ColleagueAccounts.Account]
    let current: String
    var balanced = false
    var pending: String?
    var busy = false
    let onMove: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    private var account: ColleagueAccounts.Account? { accounts.first { $0.id == current } }

    /// "A and B": the accounts Balanced spreads over, as the desktop names them.
    private var pool: String {
        let provider = account?.provider
        let names = accounts
            .filter { $0.provider == provider && $0.balanced != false }
            .map(\.label)
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + names.last!
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    HarnessIcon(harness: account?.provider ?? "claude", size: 18)
                        .frame(width: 34, height: 34)
                        .background(Theme.fill, in: .rect(cornerRadius: 8))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(providerName) usage").font(.system(size: 16, weight: .semibold))
                        Text(updated).font(Theme.meta).foregroundStyle(Theme.muted)
                    }
                }
                .padding(.bottom, 4)
                if let usage = account?.usage {
                    if let session = usage.session { card("5-hour limit", session) }
                    if let weekly = usage.weekly { card("Weekly limit", weekly) }
                } else {
                    Text(account?.error ?? "No usage read for this account yet.")
                        .font(Theme.small)
                        .foregroundStyle(account?.error == nil ? Theme.muted : Theme.delFg)
                }
                if accounts.count > 1 {
                    SectionLabel(text: "Account").padding(.top, 8)
                    VStack(spacing: 0) {
                        balancedRow
                        Divider().overlay(Theme.stroke)
                        ForEach(accounts) { entry in
                            accountRow(entry)
                            if entry.id != accounts.last?.id { Divider().overlay(Theme.stroke) }
                        }
                    }
                    .background(Theme.fillSubtle, in: .rect(cornerRadius: 10))
                    Text(busy
                        ? "It moves once the current turn ends, with its conversation."
                        : "Its conversation moves with it, on the desktop that runs it.")
                        .font(Theme.meta).foregroundStyle(Theme.faint)
                }
            }
            .padding(20)
        }
        .background(Theme.sidebar.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var providerName: String {
        account?.provider == "codex" ? "Codex" : "Claude Code"
    }

    private var updated: String {
        guard let at = account?.usage?.updatedAt else { return account?.label ?? "" }
        let seconds = Date().timeIntervalSince1970 - at / 1000
        let when = seconds < 60 ? "just now" : "\(ago(at)) ago"
        return "\(account?.label ?? "") · Updated \(when)"
    }

    private func card(_ title: String, _ window: ColleagueAccounts.Window) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).foregroundStyle(Theme.muted)
                Spacer()
                Text("\(Int(max(0, 100 - window.used).rounded()))% remaining").fontWeight(.semibold)
            }
            .font(.system(size: 14))
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.fill)
                    Capsule().fill(windowColor(window.used)).frame(width: proxy.size.width * left(window.used))
                }
            }
            .frame(height: 6)
            HStack {
                Text("\(Int(window.used.rounded()))% used")
                Spacer()
                if let at = window.resetsAt { Text("Resets in \(resetsIn(at))") }
            }
            .font(Theme.meta)
            .foregroundStyle(Theme.faint)
        }
        .padding(14)
        .background(Theme.fillSubtle, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.stroke))
    }

    private var balancedRow: some View {
        Button {
            guard !balanced, pending == nil else { return }
            onMove(Self.balancedId)
            dismiss()
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: balanced ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(balanced ? Theme.text : Theme.faint)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Balanced").foregroundStyle(Theme.text)
                    Text(balanced
                        ? "On \(account?.label ?? current) now · moves on at a limit with its conversation"
                        : "Between \(pool) · runs on the most weekly room, moves on at a limit with its conversation")
                        .font(Theme.meta)
                        .foregroundStyle(Theme.faint)
                }
                Spacer()
                if pending == Self.balancedId { Text("Moving…").foregroundStyle(Theme.muted) }
            }
            .font(.system(size: 14))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(pending != nil)
    }

    private func accountRow(_ entry: ColleagueAccounts.Account) -> some View {
        Button {
            guard (entry.id != current || balanced), pending == nil else { return }
            onMove(entry.id)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                let chosen = !balanced && entry.id == current
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen ? Theme.text : Theme.faint)
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.label).foregroundStyle(Theme.text)
                    if let error = entry.error {
                        Text(error).font(Theme.meta).foregroundStyle(Theme.delFg).lineLimit(2)
                        // The provider's sign-in opens in a browser, on the desktop.
                        Text("Sign in again from its row in sIDE on your Mac.").font(Theme.meta).foregroundStyle(Theme.faint)
                    }
                }
                Spacer()
                if entry.id == pending {
                    Text("Moving…").foregroundStyle(Theme.muted)
                } else if let usage = entry.usage {
                    Text(windowsLeft(usage)).foregroundStyle(windowColor(max(usage.session?.used ?? 0, usage.weekly?.used ?? 0)))
                }
            }
            .font(.system(size: 14).monospacedDigit())
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(pending != nil)
    }
}
