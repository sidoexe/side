import Foundation
import Observation

struct SessionRoute: Hashable {
    let projectId: String
    let sessionId: String
}

/// The tabs of the home screen, each with its own stack.
enum HomeTab: Hashable {
    case now, projects
}

/// Every screen pushed over a tab.
enum Route: Hashable {
    case session(SessionRoute)
    case newSession(projectId: String)
    case browse
    case webApp(HostWebApp)

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
    private var accountsRefreshedAt = Date.distantPast
    /// The desktop's rail, when the host keeps one: its projects and order.
    private(set) var rail: RailState?
    /// Every agent's models, for their display names.
    private(set) var catalog: HostModelCatalog?
    /// What this phone marked checked, last checked first.
    private(set) var checks: [CheckedSession] = CheckedSession.load()
    /// The desktop's web apps, read once per host.
    private(set) var webApps: [HostWebApp]?
    var error: String?
    /// The last repeating read could not reach the host.
    private(set) var offline = false
    private var pollFailures = 0
    var tab = HomeTab.now
    var paths: [HomeTab: [Route]] = [:]
    /// The stack of the tab on screen.
    var path: [Route] {
        get { paths[tab] ?? [] }
        set { paths[tab] = newValue }
    }
    /// A newer build: from the latest GitHub release, or one published next
    /// to the host (`build-ipa.sh --publish`).
    private(set) var update: AppUpdate?
    private var updateCheckedAt = Date.distantPast
    /// What the last check asked by hand found, for its alert.
    var updateCheck: String?

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
        // SIDE_ROUTE=projects | new:<projectId> | session:<projectId>:<sessionId>
        if let route = ProcessInfo.processInfo.environment["SIDE_ROUTE"]?.split(separator: ":").map(String.init) {
            switch route.first {
            case "projects": tab = .projects
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
        accounts = []
        accountsRefreshedAt = .distantPast
        catalog = nil
        webApps = nil
        paths = [:]
        tab = .now
    }

    func report(_ error: Error) {
        if error is HostClient.Unauthorized {
            Task { await signOut() }
            self.error = "This phone was signed out of the host. Pair it again."
        } else if (error as? URLError)?.code != .cancelled, !(error is CancellationError) {
            self.error = error.localizedDescription
        }
    }

    /// For reads that repeat on their own. A phone sleeps and changes network,
    /// so a dropped request waits for the next read instead of raising an
    /// alert; a host that keeps refusing is reported once, after three in a row.
    func reportPoll(_ error: Error) {
        if error is HostClient.Unauthorized { return report(error) }
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        pollFailures += 1
        if error is URLError { offline = true }
        else if pollFailures == 3 { report(error) }
    }

    /// A repeating read went through.
    func pollSucceeded() {
        pollFailures = 0
        offline = false
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
            // A project whose list fails keeps the last one it had: a folder
            // moved on the host must not hide every other session.
            var sessions: [String: [HostSessionSummary]] = [:]
            var failure: Error?
            let previous = self.sessions
            await withTaskGroup(of: (String, Result<[HostSessionSummary], Error>).self) { group in
                for project in projects {
                    group.addTask {
                        do {
                            return (project.id, .success(try await client.rpc("sessions.list", ["projectId": project.id], as: [HostSessionSummary].self)))
                        } catch {
                            return (project.id, .failure(error))
                        }
                    }
                }
                for await (id, result) in group {
                    switch result {
                    case .success(let list): sessions[id] = list
                    case .failure(let error):
                        failure = error
                        sessions[id] = previous[id] ?? []
                    }
                }
            }
            // The credential and the connection are not a project's fault.
            if let failure, failure is HostClient.Unauthorized || failure is URLError { throw failure }
            self.projects = projects
            self.sessions = sessions
            accounts = (try? await client.rpc("accounts.list", as: [HostAccountSummary].self)) ?? accounts
            await checkForUpdate()
            if can("projects.rail") { rail = try? await client.rpc("projects.rail", as: RailState.self) }
            if webApps == nil, can("webApps") {
                webApps = (try? await client.rpc("webApps.get", as: HostWebApps.self))?.apps
            }
            pollSucceeded()
        } catch {
            reportPoll(error)
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

    /// Everything waiting on the user, for the Now tab's badge.
    var waitingCount: Int { toReview.count }

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
            for tab in paths.keys { paths[tab]?.removeAll { $0.sessionId == summary.id } }
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

    /// What waits on the user, as the desktop's To review: questions first,
    /// then turns that failed, then done ones to check, each by recency.
    var toReview: [HostSessionSummary] {
        func rank(_ session: HostSessionSummary) -> Int {
            session.needsInput == true ? 0 : session.failedTurn ? 1 : 2
        }
        return sessions.values.joined()
            .filter { $0.archived != true && !$0.draftOnly && ($0.needsInput == true || $0.done) }
            .sorted { (rank($0), -$0.updatedAt) < (rank($1), -$1.updatedAt) }
    }

    /// Sessions still working, newest first.
    var working: [HostSessionSummary] {
        sessions.values.joined()
            .filter { $0.archived != true && $0.running && $0.needsInput != true }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Sessions checked on this phone, last checked first. One that works,
    /// waits or is done again leaves the list until it is checked again.
    var checked: [HostSessionSummary] {
        let all = Dictionary(sessions.values.joined().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return checks
            .compactMap { all[$0.id] }
            .filter { $0.archived != true && !$0.running && $0.needsInput != true && !$0.done }
    }

    /// The user checked a done session; it leaves To review and its project's count.
    func markChecked(_ summary: HostSessionSummary) async {
        checks = Array(([CheckedSession(id: summary.id)] + checks.filter { $0.id != summary.id }).prefix(50))
        CheckedSession.save(checks)
        await update(summary, ["reviewed": true])
    }

    // MARK: Host accounts

    /// Asks the host to read every account's usage afresh, as the desktop
    /// does when its account menu opens: at most every 20 seconds.
    func refreshAccounts(force: Bool = false) async {
        guard let client, force || Date().timeIntervalSince(accountsRefreshedAt) > 20 else { return }
        accountsRefreshedAt = Date()
        let method = can("accounts.refresh") ? "accounts.refresh" : "accounts.list"
        do {
            accounts = try await client.rpc(method, as: [HostAccountSummary].self)
        } catch {
            report(error)
        }
    }

    /// Lets the Balanced choice use an account, or stops it.
    func setBalanced(_ account: HostAccountSummary, _ balanced: Bool) async {
        await changeAccounts("accounts.balance", ["accountId": account.id, "balanced": balanced])
    }

    /// Takes an account off the host.
    func remove(_ account: HostAccountSummary) async {
        await changeAccounts("accounts.remove", ["accountId": account.id])
    }

    /// An account call that answers with the accounts after it.
    private func changeAccounts(_ method: String, _ params: [String: Any]) async {
        guard let client else { return }
        do {
            accounts = try await client.rpc(method, params, as: [HostAccountSummary].self)
        } catch {
            report(error)
        }
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
        guard force || Date().timeIntervalSince(updateCheckedAt) > 600 else { return }
        updateCheckedAt = Date()
        // Each release attaches the IPA and its build number beside it.
        let release = URL(string: "https://github.com/sidoexe/side/releases/latest/download/")!
        var found: [AppUpdate] = []
        if let published = await manifest(release.appending(path: "SideMobile.json")) {
            found.append(AppUpdate(
                version: published.version,
                build: published.number,
                ipa: URL(string: "https://github.com/sidoexe/side/releases/download/v\(published.version)/SideMobile.ipa")!
            ))
        }
        if let endpoint = connection?.endpoint,
           let published = await manifest(endpoint.appending(path: "ipa/version.json")) {
            found.append(AppUpdate(version: published.version, build: published.number, ipa: endpoint.appending(path: "ipa/SideMobile.ipa")))
        }
        let newest = found.max { $0.build < $1.build }
        update = newest.flatMap { $0.build > AppUpdate.installedBuild ? $0 : nil }
        guard force else { return }
        if let update {
            updateCheck = "\(update.version) is available."
        } else if newest == nil {
            updateCheck = "Could not reach the release to check. Try again later."
        } else {
            updateCheck = "sIDE \(AppUpdate.installedVersion) is up to date."
        }
    }

    private func manifest(_ url: URL) async -> AppUpdate.Manifest? {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let published = try? JSONDecoder().decode(AppUpdate.Manifest.self, from: data),
              published.number > 0 else { return nil }
        return published
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
        tab = .now
        path = [.session(SessionRoute(projectId: projectId, sessionId: sessionId))]
    }
}

struct AppUpdate: Equatable {
    struct Manifest: Decodable {
        let version: String
        let build: String
        var number: Int { Int(build) ?? 0 }
    }
    static var installedBuild: Int {
        Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    }
    static var installedVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
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

/// A session this phone marked checked.
struct CheckedSession: Codable, Hashable {
    let id: String

    private static let key = "home.checked"

    static func load() -> [CheckedSession] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([CheckedSession].self, from: data)) ?? []
    }

    static func save(_ checks: [CheckedSession]) {
        if let data = try? JSONEncoder().encode(checks) { UserDefaults.standard.set(data, forKey: key) }
    }
}
