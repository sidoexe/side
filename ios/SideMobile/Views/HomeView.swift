import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.connection == nil {
                ConnectView()
            } else {
                TabView(selection: $model.tab) {
                    Tab("Now", systemImage: "tray", value: HomeTab.now) {
                        TabStack(tab: .now) { NowView() }
                    }
                    .badge(model.waitingCount)
                    Tab("Projects", systemImage: "folder", value: HomeTab.projects) {
                        TabStack(tab: .projects) { ProjectsView() }
                    }
                }
            }
        }
        .background(Theme.bg)
        // Here rather than on a tab: a session opened from a notification
        // needs the host's projects and model names too.
        .task(id: model.connection?.endpoint) {
            while !Task.isCancelled, model.connection != nil {
                await model.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .alert("Check for updates", isPresented: Binding(get: { model.updateCheck != nil }, set: { if !$0 { model.updateCheck = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.updateCheck ?? "")
        }
        .alert("Host", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
    }
}

/// One tab's own stack, so switching tabs keeps where each one was.
struct TabStack<Root: View>: View {
    @Environment(AppModel.self) private var model
    let tab: HomeTab
    @ViewBuilder let root: Root

    var body: some View {
        NavigationStack(path: Binding(get: { model.paths[tab] ?? [] }, set: { model.paths[tab] = $0 })) {
            root
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .session(let session): SessionView(route: session)
                    case .newSession(let projectId): NewSessionView(projectId: projectId)
                    case .browse: FolderBrowserView()
                    case .webApp(let app): WebAppView(app: app)
                    }
                }
        }
        .toolbarBackground(Theme.sidebar, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }
}

/// What needs you, across every project: to review, working,
/// checked.
struct NowView: View {
    @Environment(AppModel.self) private var model
    @State private var checkedOpen = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let update = model.update { UpdateBanner(update: update).padding(.top, 4) }
                if !model.toReview.isEmpty {
                    SectionLabel(text: "To review")
                    ForEach(model.toReview) { reviewRow($0) }
                }
                if !model.working.isEmpty {
                    SectionLabel(text: "Working")
                    ForEach(model.working) { SessionLink(session: $0, showProject: true) }
                }
                if model.host != nil, model.waitingCount == 0, model.working.isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "checkmark.circle").font(.system(size: 28)).foregroundStyle(Theme.faint)
                        Text("Nothing waits on you").font(Theme.body).foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 48)
                }
                checkedList
            }
            .padding(.bottom, 24)
        }
        .background(Theme.sidebar.ignoresSafeArea())
        .refreshable { await model.refresh() }
        .toolbarBackground(Theme.sidebar, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { HostHeader() }.flat()
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 18) {
                    NewSessionButton()
                    HomeMenu()
                }
                .foregroundStyle(Theme.text)
            }.flat()
        }
    }

    /// A To review row, with Checked one tap away on a done one.
    private func reviewRow(_ session: HostSessionSummary) -> some View {
        HStack(spacing: 0) {
            SessionLink(session: session, showProject: true)
            if session.done {
                Button {
                    Task { await model.markChecked(session) }
                } label: {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 18))
                        .foregroundStyle(Theme.addFg)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mark checked")
                .padding(.trailing, 6)
            }
        }
    }

    /// What was checked on this phone, folded until asked for.
    @ViewBuilder private var checkedList: some View {
        let checked = model.checked
        if !checked.isEmpty {
            Button {
                checkedOpen.toggle()
            } label: {
                HStack(spacing: 6) {
                    Text("CHECKED")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.6)
                    Text("\(checked.count)").font(Theme.monoSmall)
                    Spacer(minLength: 0)
                    Image(systemName: checkedOpen ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(Theme.faint)
                .padding(.horizontal, 16)
                .padding(.top, 18)
                .padding(.bottom, 6)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Checked, \(checked.count)")
            if checkedOpen {
                ForEach(checked) { SessionLink(session: $0, showProject: true).opacity(0.6) }
            }
        }
    }
}

/// Every project of the rail, folded to its counts until opened.
struct ProjectsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("home.showArchived") private var showArchived = false
    /// The projects opened, by id, one per line.
    @AppStorage("projects.open") private var openIds = ""
    @State private var filter = ""

    private var query: String { filter.trimmingCharacters(in: .whitespaces).lowercased() }
    private var opened: Set<String> { Set(openIds.split(separator: "\n").map(String.init)) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                search
                ForEach(model.visibleProjects) { project($0) }
                if model.host != nil && model.projects.isEmpty {
                    Text("No projects yet. Open a folder of the host with the folder button.")
                        .font(Theme.small)
                        .foregroundStyle(Theme.muted)
                        .padding(16)
                }
            }
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.sidebar.ignoresSafeArea())
        .refreshable { await model.refresh() }
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.sidebar, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 18) {
                    if model.can("projects.browse") {
                        NavigationLink(value: Route.browse) { Image(systemName: "folder.badge.plus") }
                    }
                    NewSessionButton()
                    HomeMenu()
                }
                .foregroundStyle(Theme.text)
            }.flat()
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
        .padding(.bottom, 4)
    }

    private func toggle(_ id: String) {
        var ids = opened
        if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
        openIds = ids.sorted().joined(separator: "\n")
    }

    private func sessions(of project: HostProject) -> [HostSessionSummary] {
        (model.sessions[project.id] ?? [])
            .filter { !$0.draftOnly && (showArchived || $0.archived != true) }
            .filter { query.isEmpty || $0.displayName.lowercased().contains(query) || project.name.lowercased().contains(query) }
            .sorted { ($0.pinned == true ? 1 : 0, $0.updatedAt) > ($1.pinned == true ? 1 : 0, $1.updatedAt) }
    }

    @ViewBuilder
    private func project(_ project: HostProject) -> some View {
        let list = sessions(of: project)
        if query.isEmpty || !list.isEmpty {
            let open = opened.contains(project.id) || !query.isEmpty
            HStack(spacing: 8) {
                Button {
                    toggle(project.id)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: open ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.faint)
                            .frame(width: 10)
                        MascotView(seed: folderName(project.cwd), active: list.contains { $0.running })
                        Text(project.name.uppercased())
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(0.66)
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                        ProjectStatusCounts(sessions: model.sessions[project.id] ?? [])
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 36)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(project.name), \(open ? "open" : "folded")")
                Menu {
                    NavigationLink(value: Route.newSession(projectId: project.id)) { Label("New session", systemImage: "plus") }
                    Text(tilde(project.cwd))
                    if model.can("projects.rail") {
                        Button("Remove from list", role: .destructive) { Task { await model.hide(project) } }
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 13)).foregroundStyle(Theme.muted).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                NavigationLink(value: Route.newSession(projectId: project.id)) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, 16)
            .padding(.trailing, 8)
            .padding(.top, 4)
            if open {
                ForEach(list) { SessionLink(session: $0, showProject: false) }
                if list.isEmpty {
                    Text("No sessions").font(Theme.meta).foregroundStyle(Theme.faint).padding(.horizontal, 16).padding(.vertical, 4)
                }
            }
        }
    }
}

/// A session row that opens it, with its actions on a long press.
struct SessionLink: View {
    @Environment(AppModel.self) private var model
    let session: HostSessionSummary
    let showProject: Bool
    @State private var renaming = false
    @State private var deleting = false

    var body: some View {
        NavigationLink(value: Route.session(SessionRoute(projectId: session.projectId, sessionId: session.id))) {
            SessionRow(session: session, project: showProject ? model.project(session.projectId) : nil)
        }
        .buttonStyle(SessionRowStyle())
        .contextMenu {
            if session.done {
                Button("Mark checked", systemImage: "checkmark.circle") { Task { await model.markChecked(session) } }
            }
            Button(session.pinned == true ? "Unpin" : "Pin", systemImage: "pin") { Task { await model.update(session, ["pinned": session.pinned != true]) } }
            Button("Rename", systemImage: "pencil") { renaming = true }
            Button(session.archived == true ? "Unarchive" : "Archive", systemImage: "archivebox") {
                Task { await model.update(session, ["archived": session.archived != true]) }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { deleting = true }
        }
        .alert("Rename session", isPresented: $renaming) {
            RenameField(initial: session.displayName) { title in
                Task { await model.update(session, ["title": title]) }
            }
        }
        .confirmationDialog(
            "Delete \"\(session.displayName)\"? Its transcript is removed from the host.",
            isPresented: $deleting,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { Task { await model.delete(session) } }
        }
    }
}

/// The host's name beside the app's logo and version.
struct HostHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 8) {
            Image("side-logo").resizable().frame(width: 20, height: 20).clipShape(.rect(cornerRadius: 5))
            Text(model.host?.name ?? "sIDE").font(.system(size: 15, weight: .semibold)).lineLimit(1)
            // The app's own version, short enough to stay beside the
            // toolbar's buttons; the host's is in the menu.
            if model.offline {
                Image(systemName: "wifi.slash").font(.system(size: 12)).foregroundStyle(Theme.amber)
            } else {
                Text(AppUpdate.installedVersion)
                    .font(Theme.monoSmall)
                    .foregroundStyle(model.update == nil ? Theme.faint : Theme.accent)
            }
        }
        .fixedSize()
    }
}

/// A new session in the project worked in last.
struct NewSessionButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let project = recentProject {
            NavigationLink(value: Route.newSession(projectId: project.id)) { Image(systemName: "square.and.pencil") }
        }
    }

    private var recentProject: HostProject? {
        let latest = model.sessions.values.joined().max { $0.updatedAt < $1.updatedAt }
        return model.visibleProjects.first { $0.id == latest?.projectId } ?? model.visibleProjects.first
    }
}

/// Everything that is not a session: web apps, usage, updates, the host.
struct HomeMenu: View {
    @Environment(AppModel.self) private var model
    @AppStorage("home.showArchived") private var showArchived = false
    @State private var usage = false

    var body: some View {
        Menu {
            // The desktop's web apps, such as a review page, signed in as there.
            if let apps = model.webApps, !apps.isEmpty {
                Section("Web apps") {
                    ForEach(apps) { app in
                        Button(app.name, systemImage: "globe") { model.path.append(.webApp(app)) }
                    }
                }
            }
            Section {
                Button("Usage & accounts", systemImage: "gauge.with.dots.needle.50percent") { usage = true }
                Toggle("Show archived", isOn: $showArchived)
            }
            Section("App \(AppUpdate.installedVersion)" + (model.host?.version.map { " · host \($0)" } ?? "")) {
                Button("Check for updates", systemImage: "arrow.down.circle") { Task { await model.checkForUpdate(force: true) } }
            }
            if let endpoint = model.connection?.endpoint {
                Section(endpoint.host() ?? endpoint.absoluteString) {
                    Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
        .sheet(isPresented: $usage) {
            NavigationStack {
                ScrollView { UsageView(accounts: model.accounts).padding(.bottom, 24) }
                    .background(Theme.sidebar.ignoresSafeArea())
                    .navigationTitle("Usage")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { usage = false } } }
            }
            .presentationDetents([.medium, .large])
        }
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
                } else if session.running {
                    Pill(text: "Working", color: Theme.link)
                } else if session.failedTurn {
                    Pill(text: "Failed", color: Theme.delFg)
                } else if session.done {
                    Pill(text: "Done", color: Theme.addFg)
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

/// A project's working and done sessions, beside its name.
struct ProjectStatusCounts: View {
    let sessions: [HostSessionSummary]

    var body: some View {
        let live = sessions.filter { $0.archived != true && !$0.draftOnly }
        let working = live.filter { $0.running && $0.needsInput != true }.count
        let waiting = live.filter { $0.needsInput == true }.count
        let done = live.filter(\.done).count
        HStack(spacing: 8) {
            if waiting > 0 {
                HStack(spacing: 2) {
                    Image(systemName: "exclamationmark").font(.system(size: 9, weight: .bold))
                    Text("\(waiting)")
                }
                .foregroundStyle(Theme.amber)
                .accessibilityLabel("\(waiting) waiting for you")
            }
            if working > 0 {
                HStack(spacing: 3) {
                    Circle().fill(Theme.link).frame(width: 5, height: 5)
                    Text("\(working)")
                }
                .foregroundStyle(Theme.link)
                .accessibilityLabel("\(working) working")
            }
            if done > 0 {
                HStack(spacing: 2) {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold))
                    Text("\(done)")
                }
                .foregroundStyle(Theme.addFg)
                .accessibilityLabel("\(done) done, waiting to be checked")
            }
        }
        .font(.system(size: 11, weight: .semibold).monospacedDigit())
    }
}

struct SessionRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.fill : .clear)
    }
}

/// Each account's 5-hour and 7-day usage, as the web sidebar's footer, with
/// its sign-in error or limit. Opens the host's accounts.
struct UsageView: View {
    @Environment(AppModel.self) private var model
    let accounts: [HostAccountSummary]
    @State private var managing = false

    var body: some View {
        let named = accounts.filter { !$0.isPool }
        if !named.isEmpty || model.can("accounts.login") {
            HStack {
                SectionLabel(text: "Usage")
                Button("Accounts") { managing = true }
                    .font(Theme.meta)
                    .foregroundStyle(Theme.link)
                    .padding(.horizontal, 16)
                    .padding(.top, 18)
                    .padding(.bottom, 6)
            }
            VStack(spacing: 8) {
                ForEach(named) { account in
                    Button {
                        managing = true
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text(account.label).font(Theme.meta).foregroundStyle(Theme.muted).lineLimit(1)
                                Spacer()
                                if account.usage?.fiveHour != nil || account.usage?.sevenDay != nil {
                                    bar(account.usage?.fiveHour?.used, label: "5h")
                                    bar(account.usage?.sevenDay?.used, label: "7d")
                                }
                            }
                            if let until = account.limitedUntil {
                                Text("Limited until \(resetTime(until.timeIntervalSince1970 * 1000))").font(Theme.meta).foregroundStyle(Theme.amber)
                            }
                            if let error = account.usage?.error {
                                Text(error).font(Theme.meta).foregroundStyle(Theme.delFg).lineLimit(2).multilineTextAlignment(.leading)
                            }
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .sheet(isPresented: $managing) { HostAccountsSheet() }
            .onAppear { Task { await model.refreshAccounts() } }
        }
    }

    private func bar(_ used: Double?, label: String) -> some View {
        HStack(spacing: 4) {
            Text(label).font(Theme.monoSmall).foregroundStyle(Theme.faint)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.fill)
                    Capsule().fill((used ?? 0) >= 90 ? Theme.del : Theme.muted)
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

/// A newer build of this app is published next to the host. LiveContainer
/// refuses to install while one of its apps runs ("Restart LiveContainer to
/// install"), so the link is copied for Safari once LiveContainer is closed.
struct UpdateBanner: View {
    let update: AppUpdate
    @State private var copied = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text("Update available").font(.system(size: 14, weight: .semibold))
                Text("\(update.version) · build \(String(update.build))").font(Theme.monoSmall).foregroundStyle(Theme.muted)
            }
            Spacer()
            Button("Copy link") {
                UIPasteboard.general.string = update.install.absoluteString
                copied = true
            }
            .buttonStyle(ThemeButtonStyle(primary: true))
        }
        .padding(10)
        .background(Theme.accent.opacity(0.12), in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.accent.opacity(0.35)))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .alert("Link copied", isPresented: $copied) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("1. Close LiveContainer: swipe it away in the app switcher.\n2. Paste the link in Safari's address bar and open it.\n3. Choose Replace: the app keeps its data and stays paired.")
        }
    }
}
