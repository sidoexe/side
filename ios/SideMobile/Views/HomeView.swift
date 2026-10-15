import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.connection == nil {
                ConnectView()
            } else {
                NavigationStack(path: $model.path) {
                    HomeView()
                        .navigationDestination(for: Route.self) { route in
                            switch route {
                            case .session(let session): SessionView(route: session)
                            case .newSession(let projectId): NewSessionView(projectId: projectId)
                            case .colleagues: ColleaguesView()
                            case .colleague(let id): ColleagueView(id: id)
                            case .browse: FolderBrowserView()
                            }
                        }
                }
            }
        }
        .background(Theme.bg)
        // Here rather than on the sidebar: a session opened from a
        // notification needs the host's projects and model names too.
        .task(id: model.connection?.endpoint) {
            while !Task.isCancelled, model.connection != nil {
                await model.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .alert("Host", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
    }
}

/// The desktop's sidebar, full screen: what needs you now, then every
/// project of the rail with its sessions.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("home.showArchived") private var showArchived = false
    @State private var filter = ""
    @State private var expanded: Set<String> = []
    @State private var renaming: HostSessionSummary?
    @State private var deleting: HostSessionSummary?

    private var query: String { filter.trimmingCharacters(in: .whitespaces).lowercased() }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let update = model.update { UpdateBanner(update: update) }
                search
                links
                if query.isEmpty, !model.inbox.isEmpty {
                    SectionLabel(text: "Now")
                    // Also listed under their project: their own identity here.
                    ForEach(model.inbox, id: \.nowId) { row($0, showProject: true) }
                }
                SectionLabel(text: "Projects")
                ForEach(model.visibleProjects) { project($0) }
                if model.host != nil && model.projects.isEmpty {
                    Text("No projects yet. Open a folder of the host with the folder button.")
                        .font(Theme.small)
                        .foregroundStyle(Theme.muted)
                        .padding(16)
                }
                UsageView(accounts: model.accounts)
            }
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.sidebar.ignoresSafeArea())
        .refreshable { await model.refresh() }
        .toolbarBackground(Theme.sidebar, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { header }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if model.can("projects.browse") {
                    NavigationLink(value: Route.browse) { Image(systemName: "folder.badge.plus") }
                }
                if let project = recentProject {
                    NavigationLink(value: Route.newSession(projectId: project.id)) { Image(systemName: "square.and.pencil") }
                }
                menu
            }
        }
        .alert("Rename session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            RenameField(initial: renaming?.displayName ?? "") { title in
                if let session = renaming { Task { await model.update(session, ["title": title]) } }
            }
        }
        .confirmationDialog(
            "Delete \"\(deleting?.displayName ?? "")\"? Its transcript is removed from the host.",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let session = deleting { Task { await model.delete(session) } }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image("side-logo").resizable().frame(width: 20, height: 20).clipShape(.rect(cornerRadius: 5))
            Text(model.host?.name ?? "sIDE").font(.system(size: 15, weight: .semibold)).lineLimit(1)
            if let version = model.host?.version {
                Text(version).font(Theme.monoSmall).foregroundStyle(Theme.faint)
            }
        }
        .fixedSize()
    }

    private var menu: some View {
        Menu {
            Toggle("Show archived", isOn: $showArchived)
            Button("Check for updates", systemImage: "arrow.down.circle") { Task { await model.checkForUpdate(force: true) } }
            if let endpoint = model.connection?.endpoint {
                Section(endpoint.host() ?? endpoint.absoluteString) {
                    Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
    }

    private var search: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.faint)
            TextField("Filter sessions", text: $filter)
                .font(Theme.small)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.fillSubtle, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.stroke))
        .padding(.horizontal, 12)
        .padding(.top, 4)
    }

    @ViewBuilder
    private var links: some View {
        if model.can("employees"), query.isEmpty {
            NavigationLink(value: Route.colleagues) {
                HStack(spacing: 10) {
                    Image(systemName: "person.2").font(.system(size: 13)).frame(width: 16)
                    Text("Colleagues").font(Theme.body)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.faint)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
        }
    }

    private func sessions(of project: HostProject) -> [HostSessionSummary] {
        (model.sessions[project.id] ?? [])
            .filter { $0.draft != true && (showArchived || $0.archived != true) }
            .filter { query.isEmpty || $0.displayName.lowercased().contains(query) || project.name.lowercased().contains(query) }
            .sorted { ($0.pinned == true ? 1 : 0, $0.updatedAt) > ($1.pinned == true ? 1 : 0, $1.updatedAt) }
    }

    @ViewBuilder
    private func project(_ project: HostProject) -> some View {
        let list = sessions(of: project)
        if query.isEmpty || !list.isEmpty {
            HStack(spacing: 8) {
                MascotView(seed: folderName(project.cwd), active: list.contains { $0.running })
                Text(project.name.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.66)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                Spacer()
                Menu {
                    NavigationLink(value: Route.newSession(projectId: project.id)) { Label("New session", systemImage: "plus") }
                    Text(tilde(project.cwd))
                    if model.can("projects.rail") {
                        Button("Remove from list", role: .destructive) { Task { await model.hide(project) } }
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 28, height: 28)
                }
                NavigationLink(value: Route.newSession(projectId: project.id)) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted).frame(width: 28, height: 28)
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 8)
            .padding(.top, 12)
            .padding(.bottom, 2)
            let all = expanded.contains(project.id) || !query.isEmpty
            ForEach(all ? list : Array(list.prefix(5))) { row($0, showProject: false) }
            if list.count > 5, query.isEmpty {
                Button(all ? "Show less" : "Show \(list.count - 5) more") {
                    if all { expanded.remove(project.id) } else { expanded.insert(project.id) }
                }
                .font(Theme.meta)
                .foregroundStyle(Theme.muted)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
            if list.isEmpty {
                Text("No sessions").font(Theme.meta).foregroundStyle(Theme.faint).padding(.horizontal, 16).padding(.vertical, 4)
            }
        }
    }

    private func row(_ session: HostSessionSummary, showProject: Bool) -> some View {
        NavigationLink(value: Route.session(SessionRoute(projectId: session.projectId, sessionId: session.id))) {
            SessionRow(session: session, project: showProject ? model.project(session.projectId) : nil)
        }
        .buttonStyle(SessionRowStyle())
        .contextMenu {
            Button(session.pinned == true ? "Unpin" : "Pin", systemImage: "pin") { Task { await model.update(session, ["pinned": session.pinned != true]) } }
            Button("Rename", systemImage: "pencil") { renaming = session }
            Button(session.archived == true ? "Unarchive" : "Archive", systemImage: "archivebox") {
                Task { await model.update(session, ["archived": session.archived != true]) }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { deleting = session }
        }
    }

    /// The project worked in last, which a new session starts in by default.
    private var recentProject: HostProject? {
        let latest = model.sessions.values.joined().max { $0.updatedAt < $1.updatedAt }
        return model.visibleProjects.first { $0.id == latest?.projectId } ?? model.visibleProjects.first
    }
}

/// One session as the IDE's sidebar shows it: agent and model, title, branch.
struct SessionRow: View {
    @Environment(AppModel.self) private var model
    let session: HostSessionSummary
    var project: HostProject?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                HarnessIcon(harness: session.harness, size: 13)
                Text(model.modelName(harness: session.harness, model: session.model)).lineLimit(1)
                if let project {
                    Text("·")
                    Text(project.name).lineLimit(1)
                }
                Spacer(minLength: 4)
                if session.pinned == true { Image(systemName: "pin.fill").font(.system(size: 9)) }
                Text(ago(session.updatedAt)).font(Theme.monoSmall)
            }
            .font(Theme.meta)
            .foregroundStyle(Theme.muted)
            HStack(spacing: 6) {
                Text(session.displayName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(session.archived == true ? Theme.muted : Theme.text)
                    .lineLimit(1)
                    .shimmer(session.running)
                Spacer(minLength: 0)
                if session.needsInput == true {
                    Pill(text: "Needs you")
                } else if session.interrupted {
                    Pill(text: "Interrupted", color: Theme.delFg)
                }
            }
            if session.repo != nil || session.branch != nil {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 10))
                    Text([session.repo, session.branch].compactMap { $0 }.joined(separator: "/")).lineLimit(1)
                }
                .font(Theme.monoSmall)
                .foregroundStyle(Theme.faint)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .contentShape(.rect)
    }
}

struct SessionRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.fill : .clear)
    }
}

/// Each account's 5-hour and 7-day usage, as the web sidebar's footer.
struct UsageView: View {
    let accounts: [HostAccountSummary]

    var body: some View {
        let named = accounts.filter { !$0.isPool && $0.usage != nil }
        if !named.isEmpty {
            SectionLabel(text: "Usage")
            VStack(spacing: 8) {
                ForEach(named) { account in
                    HStack(spacing: 8) {
                        Text(account.label).font(Theme.meta).foregroundStyle(Theme.muted).lineLimit(1)
                        Spacer()
                        bar(account.usage?.fiveHour?.used, label: "5h")
                        bar(account.usage?.sevenDay?.used, label: "7d")
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func bar(_ used: Double?, label: String) -> some View {
        HStack(spacing: 4) {
            Text(label).font(Theme.monoSmall).foregroundStyle(Theme.faint)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.fill)
                    Capsule().fill((used ?? 0) >= 90 ? Theme.del : Theme.accent)
                        .frame(width: proxy.size.width * min(1, (used ?? 0) / 100))
                }
            }
            .frame(width: 48, height: 4)
        }
    }
}

/// The text field of a rename alert, seeded with the current name.
struct RenameField: View {
    let initial: String
    let onSave: (String) -> Void
    @State private var text = ""

    var body: some View {
        TextField("Name", text: $text).onAppear { text = initial }
        Button("Cancel", role: .cancel) {}
        Button("Save") {
            let title = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !title.isEmpty { onSave(title) }
        }
    }
}

private extension HostSessionSummary {
    var nowId: String { "now-\(id)" }
}

/// A newer build of this app is published next to the host.
struct UpdateBanner: View {
    @Environment(\.openURL) private var openURL
    let update: AppUpdate

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text("Update available").font(.system(size: 14, weight: .semibold))
                Text("\(update.version) · build \(String(update.build))").font(Theme.monoSmall).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button("Install") {
                // Outside LiveContainer, Safari downloads the IPA instead.
                openURL(update.install) { accepted in
                    if !accepted { openURL(update.ipa) }
                }
            }
            .buttonStyle(ThemeButtonStyle(primary: true))
        }
        .padding(10)
        .background(Theme.accent.opacity(0.12), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.accent.opacity(0.35)))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}
