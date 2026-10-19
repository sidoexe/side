import SwiftUI

typealias WorkItem = ColleagueAccounts.WorkItem

/// As `pinnedColleagueWork`: waiting on you, then running, then waiting to
/// be checked, newest first.
func pinnedWork(_ items: [WorkItem], keep: (WorkItem) -> Bool) -> [WorkItem] {
    func rank(_ item: WorkItem) -> Int { item.state == "input" ? 0 : item.state == "working" ? 1 : 2 }
    func recency(_ item: WorkItem) -> Double { item.settledAt ?? item.at }
    return items
        .filter(keep)
        .sorted { a, b in rank(a) != rank(b) ? rank(a) < rank(b) : recency(a) > recency(b) }
}

/// "1 needs input · 2 working · To review: 3 done", over the pinned items.
func workLine(_ pinned: [WorkItem]) -> String {
    func count(_ state: String) -> Int { pinned.filter { $0.state == state }.count }
    let settled = [("done", count("done")), ("failed", count("failed")), ("stopped", count("stopped"))]
        .filter { $0.1 > 0 }
        .map { "\($0.1) \($0.0)" }
    var parts = [
        count("input") > 0 ? "\(count("input")) needs input" : nil,
        count("working") > 0 ? "\(count("working")) working" : nil,
    ].compactMap { $0 }
    if !settled.isEmpty { parts.append("To review: " + settled.joined(separator: " · ")) }
    return parts.joined(separator: " · ")
}

private func ago(_ at: Double, _ now: Date) -> String {
    let minutes = Int(max(0, now.timeIntervalSince1970 * 1000 - at) / 60_000)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    if minutes < 24 * 60 { return "\(minutes / 60)h ago" }
    return "\(minutes / (24 * 60))d ago"
}

/// One session a colleague started. One the host runs opens here; the rest
/// run on the desktop, where a request they wait on is answered.
struct WorkRow: View {
    @Environment(AppModel.self) private var model
    let item: WorkItem
    var now = Date()
    /// On Now, among every session: say which colleague started it.
    var showColleague = false

    var body: some View {
        if let route {
            NavigationLink(value: Route.session(route)) { content }.buttonStyle(.plain)
        } else {
            content
        }
    }

    private var route: SessionRoute? {
        model.sessions.values.joined().first { $0.id == item.sessionId }
            .map { SessionRoute(projectId: $0.projectId, sessionId: $0.id) }
    }

    private var note: String {
        switch item.state {
        case "input": return (item.activity ?? "Needs input") + (route == nil ? " · answer on your desktop" : "")
        case "working": return item.activity ?? "Working"
        case "failed": return "Failed" + (item.settledAt.map { " \(ago($0, now))" } ?? "")
        case "stopped": return "Stopped" + (item.settledAt.map { " \(ago($0, now))" } ?? "")
        default: return "Done" + (item.settledAt.map { " \(ago($0, now))" } ?? "")
        }
    }

    private var content: some View {
        HStack(spacing: 10) {
            icon.frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(displayTitle(item.title, harness: item.harness))
                    .font(.system(size: 14))
                    .lineLimit(1)
                Text(([note, folderName(item.cwd)] + (showColleague ? model.colleague(of: item.sessionId).map { ["by \($0.displayName)"] } ?? [] : [])).joined(separator: " · "))
                    .font(Theme.meta)
                    .foregroundStyle(item.state == "input" ? Theme.amber : Theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if route != nil {
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.faint)
            }
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
    }

    @ViewBuilder private var icon: some View {
        switch item.state {
        case "working": ProgressView().controlSize(.mini)
        case "input": Image(systemName: "clock").foregroundStyle(Theme.amber)
        case "failed": Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.del)
        case "stopped": Image(systemName: "xmark.circle").foregroundStyle(Theme.muted)
        default: Image(systemName: "checkmark.circle").foregroundStyle(Theme.add)
        }
    }
}

/// Above a colleague's chat: its part of Now, the sessions running, waiting
/// or waiting to be checked, however far the chat scrolls.
struct ColleagueWorkCard: View {
    @Environment(AppModel.self) private var model
    let items: [WorkItem]
    @State private var open = true
    @State private var all = false

    private static let rows = 3

    var body: some View {
        let pinned = pinnedWork(items, keep: model.onNow)
        if !pinned.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Button {
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(pinned.contains { $0.state == "input" } ? Theme.amber : pinned.contains { $0.state == "working" } ? Theme.link : Theme.faint)
                            .frame(width: 6, height: 6)
                        Text(workLine(pinned))
                            .font(Theme.meta)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: open ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Theme.faint)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(open ? "Hide sessions" : "Show sessions")
                if open {
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(all ? pinned : Array(pinned.prefix(Self.rows))) { WorkRow(item: $0, now: context.date) }
                        }
                    }
                    if pinned.count > Self.rows && !all {
                        Button("\(pinned.count - Self.rows) more") { withAnimation(.snappy) { all = true } }
                            .font(Theme.meta)
                            .foregroundStyle(Theme.muted)
                    }
                }
            }
            .card(padding: 10, radius: 10)
        }
    }
}
