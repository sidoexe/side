import SwiftUI

/// A colleague's face: their emoji, else their mascot in their colour.
struct MonoAvatar: View {
    let mono: Mono
    var size: CGFloat = 16

    var body: some View {
        if let avatar = mono.avatar, avatar.kind == "emoji" {
            Text(avatar.value).font(.system(size: size * 0.9)).frame(width: size, height: size)
        } else {
            MascotView(seed: mono.id, name: mono.mascot, color: Color(css: mono.color) ?? Theme.accent, size: size)
        }
    }
}

/// Colleagues kept on the host: who they are and what they work on.
struct ColleaguesView: View {
    @Environment(AppModel.self) private var model
    @State private var roster: [Mono]?
    @State private var accounts: ColleagueAccounts?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                if let roster {
                    if roster.isEmpty {
                        Text("No colleagues on this host. They live here when it is your home machine.")
                            .font(Theme.small).foregroundStyle(Theme.muted).padding(16)
                    }
                    ForEach(roster) { mono in
                        NavigationLink(value: Route.colleague(mono.id)) {
                            HStack(spacing: 12) {
                                MonoAvatar(mono: mono, size: 22)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(mono.displayName).font(.system(size: 15, weight: .semibold))
                                    ColleagueStatusLine(
                                        state: accounts?.status?[mono.id],
                                        fallback: mono.projects.map(folderName).joined(separator: ", ").ifEmpty("No projects")
                                    )
                                    .font(Theme.meta).foregroundStyle(Theme.muted)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .contentShape(.rect)
                        }
                        .buttonStyle(SessionRowStyle())
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
            }
            .padding(.top, 8)
        }
        .background(Theme.sidebar.ignoresSafeArea())
        .navigationTitle("Colleagues")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.sidebar, for: .navigationBar)
        .refreshable { await load() }
        .task {
            // Their states change as they work; read them again while open.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    private func load() async {
        do {
            roster = try await model.client?.rpc("employees.roster", as: MonoRoster.self).roster
            if model.can("employees.accounts") {
                accounts = (try? await model.client?.rpc("employees.accounts", as: ColleagueAccounts?.self)) ?? accounts
            }
        } catch {
            model.report(error)
        }
    }
}

/// One colleague: their conversation, memory and soul. Their chats run on a
/// desktop: a message written here waits on the host until an open desktop
/// takes it, and the reply shows here as that desktop saves the chat.
struct ColleagueView: View {
    @Environment(AppModel.self) private var model
    let id: String

    private enum Tab: String, CaseIterable {
        case chat = "Conversation", memory = "Memory", soul = "Soul"
    }

    @State private var mono: Mono?
    @State private var tab = Tab.chat
    @State private var files: MonoFiles?
    @State private var chat: [Block]?
    @State private var items: [TranscriptItem] = []
    @State private var inbox: [InboxMessage] = []
    @State private var accounts: ColleagueAccounts?
    @State private var showsUsage = false
    @State private var wasWorking = false
    /// The thread shown: nil follows the open one, `new` starts another.
    @State private var thread: String?
    /// The open thread when a new one was asked for, to notice it start.
    @State private var newFrom: String?
    @State private var now = Date()
    @State private var atEnd = true

    private var canWrite: Bool { model.can("employees.inbox") }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            switch tab {
            case .chat: conversation
            case .memory: document(files?.memory)
            case .soul: document(files?.soul)
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    HStack(spacing: 8) {
                        if let mono { MonoAvatar(mono: mono, size: 16) }
                        Text(mono?.displayName ?? "Colleague").font(.system(size: 15, weight: .semibold))
                    }
                    if let state = shownState, state.status != "idle" {
                        ColleagueStatusLine(state: state).font(.system(size: 11))
                    }
                    threadMenu
                }
            }.flat()
        }
        .task(id: id) {
            files = try? await model.client?.rpc("employees.load", ["mono": id], as: MonoFiles.self)
        }
        .task(id: id) { await poll() }
        #if DEBUG
        // SIDE_OPEN=usage opens the usage detail on a scripted simulator run.
        .task {
            let open = ProcessInfo.processInfo.environment["SIDE_OPEN"] ?? ""
            if open == "usage" { try? await Task.sleep(for: .seconds(3)); showsUsage = true }
            // SIDE_OPEN=thread:<id> shows that thread.
            if open.hasPrefix("thread:") { select(String(open.dropFirst("thread:".count))) }
        }
        #endif
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if chat == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(40)
                    } else if items.isEmpty && inbox.isEmpty {
                        Text("No conversation yet.").font(Theme.small).foregroundStyle(Theme.muted)
                    }
                    ForEach(items) { TranscriptItemView(item: $0) }
                    // What it is doing on its desktop, until the next steps
                    // of its chat arrive here.
                    if let state = shownState, state.status == "working" {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text((state.activity ?? "Thinking") + "…")
                                .font(Theme.small)
                                .foregroundStyle(Theme.muted)
                                .lineLimit(1)
                                .shimmer(true)
                        }
                        .transition(.opacity)
                    }
                    ForEach(inbox.filter(isShown)) { message in
                        VStack(alignment: .trailing, spacing: 4) {
                            Text(message.account.map { "Switch to \(accountLabel($0))" } ?? message.text)
                                .font(.system(size: 15))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(Theme.fill, in: .rect(cornerRadius: 10))
                                .opacity(0.7)
                            Text(waiting(message)).font(Theme.meta).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing)
                        }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self, of: showsEnd) { _, end in atEnd = end }
            .onChange(of: items.count + inbox.count) { if atEnd { proxy.scrollTo("end", anchor: .bottom) } }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 6) {
                    if !atEnd {
                        JumpToEnd { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
                    }
                    if canWrite {
                        ComposerView(
                            placeholder: thread == Self.newThread ? "Start a new thread with \(mono?.displayName ?? "")" : "Message \(mono?.displayName ?? "")",
                            allowsAttachments: false,
                            hint: "Via your desktop",
                            onSend: { outgoing in try await post(outgoing.text) },
                            context: { EmptyView() },
                            tools: { accountChip }
                        )
                    } else {
                        Text("Writing to a colleague from the phone needs sIDE Host 0.28 or later. Update the host from the desktop.")
                            .font(Theme.meta)
                            .foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .card(padding: 10, radius: 8)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
                .background(Theme.bg.opacity(0.92).ignoresSafeArea(edges: .bottom))
            }
        }
    }

    /// The colleague's plan usage, as the desktop shows it under the
    /// composer; it opens the detail, where it can move to another account.
    @ViewBuilder private var accountChip: some View {
        if let current = accounts?.current[id] {
            let pending = inbox.last { $0.account != nil }?.account
            UsageStrip(
                provider: current.provider,
                usage: accounts?.accounts.first { $0.id == current.account && $0.provider == current.provider }?.usage,
                balanced: current.balanced == true,
                pending: pending.map(accountLabel)
            ) { showsUsage = true }
            .sheet(isPresented: $showsUsage) {
                UsageSheet(
                    accounts: accounts?.accounts.filter { $0.provider == current.provider } ?? [],
                    current: current.account,
                    balanced: current.balanced == true,
                    pending: pending,
                    busy: accounts?.status?[id]?.status == "working"
                ) { account in
                    Task {
                        do { try await move(to: account) } catch { model.report(error) }
                    }
                }
            }
        }
    }

    private func accountLabel(_ id: String) -> String {
        if id == UsageSheet.balancedId { return "Balanced" }
        return accounts?.accounts.first { $0.id == id }?.label ?? (id == "default" ? "Default" : id)
    }

    private func move(to account: String) async throws {
        guard let client = model.client else { return }
        let message = try await client.rpc("employees.post", ["mono": id, "account": account], as: InboxMessage.self)
        inbox.append(message)
    }

    private func document(_ text: String?) -> some View {
        ScrollView {
            MarkdownView(text: text?.isEmpty == false ? text! : "_Empty._")
                .padding(16)
        }
    }

    private func waiting(_ message: InboxMessage) -> String {
        if message.takenBy != nil { return "Sending from a desktop…" }
        if now.timeIntervalSince1970 * 1000 - message.at > 10_000 {
            return "Waiting for a desktop: open sIDE on one of your computers to send it."
        }
        return "Waiting for a desktop…"
    }

    private func post(_ text: String) async throws {
        guard let client = model.client else { return }
        var params: [String: Any] = ["mono": id, "text": text]
        if let thread { params["thread"] = thread }
        let message = try await client.rpc("employees.post", params, as: InboxMessage.self)
        if thread == Self.newThread { newFrom = mono?.sessionId }
        inbox.append(message)
    }

    private static let newThread = "new"

    /// The conversation on screen: the chosen one, else the open one.
    private var shownThread: String? { thread ?? mono?.sessionId }

    private var shownState: ColleagueAccounts.State? {
        guard let shown = shownThread else { return nil }
        if let state = accounts?.threads?[shown] { return state }
        return shown == mono?.sessionId ? accounts?.status?[id] : nil
    }

    private func isShown(_ message: InboxMessage) -> Bool {
        if message.account != nil { return true }
        if thread == Self.newThread { return message.thread == Self.newThread }
        return (message.thread ?? mono?.sessionId) == shownThread
    }

    private func title(_ entry: Mono.Thread) -> String { entry.title ?? "New conversation" }

    /// Its conversations, each on its own topic, and a new one.
    @ViewBuilder private var threadMenu: some View {
        if let mono, !mono.allThreads.isEmpty {
            Menu {
                Button { select(Self.newThread) } label: { Label("New thread", systemImage: "plus") }
                Divider()
                ForEach(mono.allThreads) { entry in
                    let working = accounts?.threads?[entry.id]?.status == "working"
                    Button { select(entry.id == mono.sessionId ? nil : entry.id) } label: {
                        if entry.id == shownThread { Label(title(entry), systemImage: "checkmark") }
                        else { Text(working ? "\(title(entry)) · working" : title(entry)) }
                    }
                }
            } label: {
                HStack(spacing: 3) {
                    Text(thread == Self.newThread ? "New thread" : mono.allThreads.first { $0.id == shownThread }.map(title) ?? "New conversation")
                        .lineLimit(1)
                    if mono.allThreads.count > 1 { Text("\(mono.allThreads.count)").foregroundStyle(Theme.faint) }
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                }
                .font(.system(size: 11))
                .foregroundStyle(Theme.muted)
            }
            .buttonStyle(.plain)
        }
    }

    private func select(_ next: String?) {
        guard next != thread else { return }
        thread = next
        chat = next == Self.newThread ? [] : nil
        items = []
        wasWorking = false
    }

    private func poll() async {
        guard let client = model.client else { return }
        while !Task.isCancelled {
            do {
                // A first message gives the colleague its chat on the desktop
                // that takes it; the roster then names it.
                // Read each time: its threads and their names change.
                mono = try await client.rpc("employees.roster", as: MonoRoster.self).roster.first { $0.id == id } ?? mono
                // The new thread started on the desktop: follow it.
                if thread == Self.newThread, let open = mono?.sessionId, open != newFrom,
                   !inbox.contains(where: { $0.thread == Self.newThread }) {
                    select(nil)
                }
                if thread == Self.newThread {
                    // Nothing to read until the desktop starts it.
                } else if let sessionId = shownThread {
                    let transcript = try await client.rpc("employees.sessionGet", ["sessionId": sessionId], as: ColleagueTranscript?.self)
                    let blocks = transcript?.blocks ?? []
                    let working = shownState?.status == "working"
                    if blocks != chat || working != wasWorking {
                        chat = blocks
                        wasWorking = working
                        items = TranscriptItem.build(MonoReaction.blocks(blocks), running: working)
                    }
                } else if chat == nil {
                    chat = []
                }
                if canWrite {
                    inbox = (try? await client.rpc("employees.inbox", ["mono": id], as: [InboxMessage].self)) ?? inbox
                }
                if model.can("employees.accounts") {
                    accounts = (try? await client.rpc("employees.accounts", as: ColleagueAccounts?.self)) ?? accounts
                }
                now = Date()
            } catch {
                model.report(error)
            }
            // Closer while it works, so its steps follow the desktop's.
            try? await Task.sleep(for: wasWorking ? .seconds(1.2) : .seconds(2.5))
        }
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
