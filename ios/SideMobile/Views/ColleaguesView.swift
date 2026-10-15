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
                                    Text(mono.projects.map(folderName).joined(separator: ", ").ifEmpty("No projects"))
                                        .font(Theme.meta).foregroundStyle(Theme.muted).lineLimit(1)
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
        .task { await load() }
    }

    private func load() async {
        do {
            roster = try await model.client?.rpc("employees.roster", as: MonoRoster.self).roster
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
                HStack(spacing: 8) {
                    if let mono { MonoAvatar(mono: mono, size: 16) }
                    Text(mono?.displayName ?? "Colleague").font(.system(size: 15, weight: .semibold))
                }
            }.flat()
        }
        .task(id: id) {
            files = try? await model.client?.rpc("employees.load", ["mono": id], as: MonoFiles.self)
        }
        .task(id: id) { await poll() }
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
                    ForEach(inbox) { message in
                        VStack(alignment: .trailing, spacing: 4) {
                            Text(message.text)
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
                            placeholder: "Message \(mono?.displayName ?? "")",
                            allowsAttachments: false,
                            hint: "Sent through a desktop with sIDE open",
                            onSend: { outgoing in try await post(outgoing.text) },
                            context: { EmptyView() },
                            tools: { EmptyView() }
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
        let message = try await client.rpc("employees.post", ["mono": id, "text": text], as: InboxMessage.self)
        inbox.append(message)
    }

    private func poll() async {
        guard let client = model.client else { return }
        while !Task.isCancelled {
            do {
                // A first message gives the colleague its chat on the desktop
                // that takes it; the roster then names it.
                if mono?.sessionId == nil {
                    mono = try await client.rpc("employees.roster", as: MonoRoster.self).roster.first { $0.id == id }
                }
                if let sessionId = mono?.sessionId {
                    let transcript = try await client.rpc("employees.sessionGet", ["sessionId": sessionId], as: ColleagueTranscript?.self)
                    let blocks = transcript?.blocks ?? []
                    if blocks != chat {
                        chat = blocks
                        items = TranscriptItem.build(blocks, running: false)
                    }
                } else if chat == nil {
                    chat = []
                }
                if canWrite {
                    inbox = (try? await client.rpc("employees.inbox", ["mono": id], as: [InboxMessage].self)) ?? inbox
                }
                now = Date()
            } catch {
                model.report(error)
            }
            try? await Task.sleep(for: .seconds(2.5))
        }
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
