import SwiftUI

typealias WorkItem = ColleagueAccounts.WorkItem

/// When this phone last showed each colleague: what ended before then is
/// not news here, whatever the desktop has shown.
enum ColleagueSeen {
    private static func key(_ id: String) -> String { "colleagueSeen.\(id)" }
    static func at(_ id: String) -> Double { UserDefaults.standard.double(forKey: key(id)) }
    static func mark(_ id: String) {
        UserDefaults.standard.set(Date().timeIntervalSince1970 * 1000, forKey: key(id))
    }
}

/// As `pinnedColleagueWork`: waiting on you, then running, then ended since
/// the last visit, newest first.
func pinnedWork(_ items: [WorkItem], seenAt: Double) -> [WorkItem] {
    func rank(_ item: WorkItem) -> Int { item.state == "input" ? 0 : item.state == "working" ? 1 : 2 }
    func recency(_ item: WorkItem) -> Double { item.settledAt ?? item.at }
    return items
        .filter { $0.active || ($0.settledAt ?? 0) > seenAt }
        .sorted { a, b in rank(a) != rank(b) ? rank(a) < rank(b) : recency(a) > recency(b) }
}

/// "1 needs input · 2 working · 3 done since last visit".
func workLine(_ items: [WorkItem], seenAt: Double) -> String {
    func count(_ state: String, since: Bool = false) -> Int {
        items.filter { $0.state == state && (!since || ($0.settledAt ?? 0) > seenAt) }.count
    }
    let ended = [("done", count("done", since: true)), ("failed", count("failed", since: true)), ("stopped", count("stopped", since: true))]
        .filter { $0.1 > 0 }
        .map { "\($0.1) \($0.0)" }
    var parts = [
        count("input") > 0 ? "\(count("input")) needs input" : nil,
        count("working") > 0 ? "\(count("working")) working" : nil,
    ].compactMap { $0 }
    if !ended.isEmpty { parts.append(ended.joined(separator: " · ") + " since last visit") }
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
                Text("\(note) · \(folderName(item.cwd))")
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

/// Above a colleague's chat: its sessions running or waiting, and the ones
/// that ended since the last visit, however far the chat scrolls.
struct ColleagueWorkCard: View {
    let items: [WorkItem]
    let seenAt: Double
    @State private var open = true
    @State private var all = false

    private static let rows = 3

    var body: some View {
        let pinned = pinnedWork(items, seenAt: seenAt)
        if !pinned.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Button {
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(pinned.contains { $0.state == "input" } ? Theme.amber : pinned.contains { $0.state == "working" } ? Theme.link : Theme.faint)
                            .frame(width: 6, height: 6)
                        Text(workLine(items, seenAt: seenAt))
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

/// Every colleague's work at once: the ones with a session waiting on you
/// first. Shown at the top of the colleagues list.
struct ColleagueBoard: View {
    let roster: [Mono]
    let work: [String: [WorkItem]]

    var body: some View {
        let groups = roster.compactMap { mono -> (Mono, [WorkItem])? in
            let pinned = pinnedWork(work[mono.id] ?? [], seenAt: ColleagueSeen.at(mono.id))
            return pinned.isEmpty ? nil : (mono, pinned)
        }
        .sorted { a, b in
            let wa = a.1.contains { $0.state == "input" }, wb = b.1.contains { $0.state == "input" }
            return wa != wb ? wa : a.1.filter(\.active).count > b.1.filter(\.active).count
        }
        if !groups.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Work").font(Theme.meta).foregroundStyle(Theme.muted)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(groups, id: \.0.id) { mono, items in
                            VStack(alignment: .leading, spacing: 0) {
                                NavigationLink(value: Route.colleague(mono.id)) {
                                    HStack(spacing: 6) {
                                        MonoAvatar(mono: mono, size: 14)
                                        Text(mono.displayName).font(.system(size: 13, weight: .semibold))
                                        Spacer(minLength: 0)
                                    }
                                    .contentShape(.rect)
                                }
                                .buttonStyle(.plain)
                                ForEach(items) { WorkRow(item: $0, now: context.date) }
                            }
                        }
                    }
                }
            }
            .card(padding: 12, radius: 10)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
    }
}
