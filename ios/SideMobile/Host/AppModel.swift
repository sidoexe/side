import Foundation
import Observation

struct SessionRoute: Hashable {
    let projectId: String
    let sessionId: String
}

/// Every screen pushed over the sidebar.
enum Route: Hashable {
    case session(SessionRoute)
    case newSession(projectId: String)
    case colleagues
    case colleague(String)
    case browse

    var sessionId: String? {
        if case .session(let route) = self { route.sessionId } else { nil }
    }
}

@MainActor
@Observable
final class AppModel {
    private(set) var connection: Connection?
    private(set) var client: HostClient?
    private(set) var host: HostDescriptor?
    private(set) var projects: [HostProject] = []
    private(set) var sessions: [String: [HostSessionSummary]] = [:]
    private(set) var accounts: [HostAccountSummary] = []
    /// The desktop's rail, when the host keeps one: its projects and order.
    private(set) var rail: RailState?
    /// Every agent's models, for their display names.
    private(set) var catalog: HostModelCatalog?
    var error: String?
    var path: [Route] = []
    /// A newer build published next to the host (`build-ipa.sh --publish`).
    private(set) var update: AppUpdate?
    private var updateCheckedAt = Date.distantPast

    /// The APNs token, once iOS hands it over; sent to every host signed in to.
    private var apnsToken: String?

    init() {
        #if DEBUG
        // Simulator runs pair without the "Open in sIDE?" prompt:
        // SIMCTL_CHILD_SIDE_PAIR_LINK=side://pair?… xcrun simctl launch …
        if let link = ProcessInfo.processInfo.environment["SIDE_PAIR_LINK"],
           let connection = Connection.parse(address: link, token: "") {
            connection.save()
        }
        #endif
        if let saved = Connection.load() { use(saved) }
        #if DEBUG
        // SIDE_ROUTE=colleagues | colleague:<id> | new:<projectId> | session:<projectId>:<sessionId>
        if let route = ProcessInfo.processInfo.environment["SIDE_ROUTE"]?.split(separator: ":").map(String.init) {
            switch route.first {
            case "colleagues": path = [.colleagues]
            case "colleague" where route.count == 2: path = [.colleagues, .colleague(route[1])]
            case "new" where route.count == 2: path = [.newSession(projectId: route[1])]
            case "session" where route.count == 3: path = [.session(SessionRoute(projectId: route[1], sessionId: route[2]))]
            case "browse": path = [.browse]
            default: break
            }
        }
        #endif
    }

    private func use(_ connection: Connection) {
        self.connection = connection
        client = HostClient(endpoint: connection.endpoint, token: connection.token)
        host = nil
    }

    /// Checks the credential before keeping it.
    func connect(_ connection: Connection) async throws {
        let client = HostClient(endpoint: connection.endpoint, token: connection.token)
        _ = try await client.describe()
        connection.save()
        use(connection)
        await refresh()
    }

    func signOut() async {
        if let client, let apnsToken {
            _ = try? await client.rpc("push.unregisterApns", ["token": apnsToken], as: HostClient.Ignored.self)
        }
        Connection.clear()
        connection = nil
        client = nil
        host = nil
        projects = []
        sessions = [:]
        rail = nil
        catalog = nil
        path = []
    }

    func report(_ error: Error) {
        if error is HostClient.Unauthorized {
            Task { await signOut() }
            self.error = "This phone was signed out of the host. Pair it again."
        } else if (error as? URLError)?.code != .cancelled, !(error is CancellationError) {
            self.error = error.localizedDescription
        }
    }

    /// The host, its projects and their sessions.
    func refresh() async {
        guard let client else { return }
        do {
            if host == nil {
                host = try await client.describe()
                await registerPush()
                catalog = try? await client.rpc("models.list", as: HostModelCatalog.self)
            }
            let projects = try await client.rpc("projects.list", as: [HostProject].self)
            var sessions: [String: [HostSessionSummary]] = [:]
            try await withThrowingTaskGroup(of: (String, [HostSessionSummary]).self) { group in
                for project in projects {
                    group.addTask { (project.id, try await client.rpc("sessions.list", ["projectId": project.id], as: [HostSessionSummary].self)) }
                }
                for try await (id, list) in group { sessions[id] = list }
            }
            self.projects = projects
            self.sessions = sessions
            accounts = (try? await client.rpc("accounts.list", as: [HostAccountSummary].self)) ?? accounts
            await checkForUpdate()
            if can("projects.rail") { rail = try? await client.rpc("projects.rail", as: RailState.self) }
        } catch {
            report(error)
        }
    }

    func can(_ capability: String) -> Bool {
        host?.capabilities.contains(capability) == true
    }

    /// As the web app's `visibleProjects`: the rail's, in its order, when the
    /// desktop sent one; otherwise every project but the archived ones.
    var visibleProjects: [HostProject] {
        if let rail, !rail.projects.isEmpty {
            let byCwd = Dictionary(projects.map { ($0.cwd, $0) }, uniquingKeysWith: { a, _ in a })
            return rail.projects.compactMap { byCwd[$0] }
        }
        return projects.filter { !(rail?.archived.contains($0.cwd) ?? false) }
    }

    /// Sessions waiting on the user, for the badge.
    var attention: Int {
        sessions.values.joined().filter { $0.needsInput == true && $0.archived != true }.count
    }

    /// "Claude Opus 5" rather than "opus".
    func modelName(harness: String, model: String?) -> String {
        guard let model else { return harness.capitalized }
        if let found = catalog?.models[harness]?.first(where: { $0.matches(model) }) { return found.name }
        return model.split(separator: ":").last.map(String.init) ?? model
    }

    func setRail(projects: [String], archived: [String]) async {
        guard let client else { return }
        do {
            rail = try await client.rpc("projects.setRail", ["projects": projects, "archived": archived], as: RailState.self)
        } catch {
            report(error)
        }
    }

    /// Opens a host folder as a project and lists it, as the desktop's rail does.
    func openProject(cwd: String) async -> HostProject? {
        guard let client else { return nil }
        do {
            let opened = try await client.rpc("projects.open", ["cwd": cwd], as: HostProject.self)
            if !projects.contains(where: { $0.id == opened.id }) { projects.append(opened) }
            if let rail, !visibleProjects.contains(where: { $0.cwd == opened.cwd }) {
                await setRail(projects: visibleProjects.map(\.cwd) + [opened.cwd], archived: rail.archived.filter { $0 != opened.cwd })
            }
            return opened
        } catch {
            report(error)
            return nil
        }
    }

    func hide(_ project: HostProject) async {
        await setRail(
            projects: visibleProjects.map(\.cwd).filter { $0 != project.cwd },
            archived: [project.cwd] + (rail?.archived ?? [])
        )
    }

    func delete(_ summary: HostSessionSummary) async {
        guard let client else { return }
        do {
            _ = try await client.rpc("sessions.delete", ["projectId": summary.projectId, "sessionId": summary.id], as: HostClient.Ignored.self)
            path.removeAll { $0.sessionId == summary.id }
            await refresh()
        } catch {
            report(error)
        }
    }

    func summary(_ route: SessionRoute) -> HostSessionSummary? {
        sessions[route.projectId]?.first { $0.id == route.sessionId }
    }

    func project(_ id: String) -> HostProject? {
        projects.first { $0.id == id }
    }

    /// What needs the user: questions first, then done sessions to check,
    /// then running ones, each by recency.
    var inbox: [HostSessionSummary] {
        func rank(_ session: HostSessionSummary) -> Int {
            session.needsInput == true ? 0 : session.done ? 1 : 2
        }
        return sessions.values.joined()
            .filter { $0.archived != true && $0.draft != true && ($0.needsInput == true || $0.running || $0.done) }
            .sorted { (rank($0), -$0.updatedAt) < (rank($1), -$1.updatedAt) }
    }

    /// The user checked a done session; it leaves Now and its project's count.
    func markChecked(_ summary: HostSessionSummary) async {
        await update(summary, ["reviewed": true])
    }

    func update(_ summary: HostSessionSummary, _ patch: [String: Any]) async {
        guard let client else { return }
        var params = patch
        params["projectId"] = summary.projectId
        params["sessionId"] = summary.id
        do {
            _ = try await client.rpc("sessions.update", params, as: HostClient.Ignored.self)
            await refresh()
        } catch {
            report(error)
        }
    }

    // MARK: Updates

    /// Every 10 minutes at most: is there a newer build at `<host>/ipa`?
    func checkForUpdate(force: Bool = false) async {
        guard let endpoint = connection?.endpoint, force || Date().timeIntervalSince(updateCheckedAt) > 600 else { return }
        updateCheckedAt = Date()
        let manifest = endpoint.appending(path: "ipa/version.json")
        var request = URLRequest(url: manifest, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let published = try? JSONDecoder().decode(AppUpdate.Manifest.self, from: data),
              let build = Int(published.build) else { return }
        let installed = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
        update = build > installed
            ? AppUpdate(version: published.version, build: build, ipa: endpoint.appending(path: "ipa/SideMobile.ipa"))
            : nil
    }

    // MARK: Push

    func didRegister(apnsToken token: Data) {
        apnsToken = token.map { String(format: "%02x", $0) }.joined()
        Task { await registerPush() }
    }

    private func registerPush() async {
        guard let client, let apnsToken, host?.capabilities.contains("push.apns") == true else { return }
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        _ = try? await client.rpc("push.registerApns", [
            "token": apnsToken, "environment": environment, "bundleId": Bundle.main.bundleIdentifier ?? "",
        ], as: HostClient.Ignored.self)
    }

    /// A tapped notification opens its session.
    func open(projectId: String, sessionId: String) {
        path = [.session(SessionRoute(projectId: projectId, sessionId: sessionId))]
    }
}

struct AppUpdate: Equatable {
    struct Manifest: Decodable {
        let version: String
        let build: String
    }
    let version: String
    let build: Int
    let ipa: URL

    /// LiveContainer installs it over the current copy, keeping its data.
    var install: URL {
        var components = URLComponents()
        components.scheme = "livecontainer"
        components.host = "install"
        components.queryItems = [URLQueryItem(name: "url", value: ipa.absoluteString)]
        return components.url!
    }
}
