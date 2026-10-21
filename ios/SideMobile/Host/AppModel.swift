import Foundation
import Observation

struct SessionRoute: Hashable {
    let machineId: String
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
    case newSession(machineId: String, projectId: String)
    case browse(machineId: String)
    case webApp(HostWebApp)

    var sessionId: String? {
        if case .session(let route) = self { route.sessionId } else { nil }
    }
    var machineId: String? {
        switch self {
        case .session(let route): route.machineId
        case .newSession(let machineId, _), .browse(let machineId): machineId
        case .webApp: nil
        }
    }
}

/// One paired machine: its own host, which is the only engine for its
/// sessions, and what the phone last read from it.
@MainActor
@Observable
final class Machine: Identifiable {
    let id: String
    private(set) var connection: Connection
    let client: HostClient
    var host: HostDescriptor?
    var projects: [HostProject] = []
    var sessions: [String: [HostSessionSummary]] = [:]
    var accounts: [HostAccountSummary] = []
    var accountsRefreshedAt = Date.distantPast
    /// The desktop's rail, when the host keeps one: its projects and order.
    var rail: RailState?
    /// Every agent's models, for their display names.
    var catalog: HostModelCatalog?
    /// The desktop's web apps, read once per host.
    var webApps: [HostWebApp]?
    /// The last read could not reach it; it keeps what it had.
    var offline = false
    var pollFailures = 0

    init(_ connection: Connection) {
        id = connection.id
        self.connection = connection
        client = HostClient(endpoint: connection.endpoint, token: connection.token)
    }

    /// The name the user gave it, else its host's.
    var name: String { connection.name ?? host?.name ?? connection.endpoint.host() ?? "Machine" }

    func rename(_ name: String?) { connection.name = name }

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

    /// "Claude Opus 5" rather than "opus".
    func modelName(harness: String, model: String?) -> String {
        guard let model else { return harness.capitalized }
        if let found = catalog?.models[harness]?.first(where: { $0.matches(model) }) { return found.name }
        return model.split(separator: ":").last.map(String.init) ?? model
    }

    /// Whether the host can sign in an account of this provider from here:
    /// Claude with `accounts.login`, Codex with `accounts.login.codex` as well.
    func canSignIn(provider: String) -> Bool {
        guard can("accounts.login") else { return false }
        return provider == "claude" || (provider == "codex" && can("accounts.login.codex"))
    }
}

@MainActor
@Observable
final class AppModel {
    /// Every paired machine, in the order they were paired.
    private(set) var machines: [Machine] = []
    /// What this phone marked checked (`machine:session`), last checked first.
    private(set) var checks: [CheckedSession] = CheckedSession.load()
    var error: String?
    var tab = HomeTab.now
    var paths: [HomeTab: [Route]] = [:]
    /// The stack of the tab on screen.
    var path: [Route] {
        get { paths[tab] ?? [] }
        set { paths[tab] = newValue }
    }
    /// A newer build: from the latest GitHub release, or one published next
    /// to a host (`build-ipa.sh --publish`).
    private(set) var update: AppUpdate?
    private var updateCheckedAt = Date.distantPast
    /// What the last check asked by hand found, for its alert.
    var updateCheck: String?

    /// The APNs token, once iOS hands it over; sent to every machine.
    private var apnsToken: String?

    init() {
        #if DEBUG
        // Simulator runs pair without the "Open in sIDE?" prompt:
        // SIMCTL_CHILD_SIDE_PAIR_LINK=side://pair?… xcrun simctl launch …
        // Several links, separated by spaces, pair several machines.
        if let links = ProcessInfo.processInfo.environment["SIDE_PAIR_LINK"] {
            let pairs = links.split(separator: " ").compactMap { Connection.parse(address: String($0), token: "") }
            if !pairs.isEmpty { Connection.saveAll(pairs) }
        }
        #endif
        machines = Connection.loadAll().map(Machine.init)
        #if DEBUG
        // SIDE_ROUTE=projects | browse | new:<projectId> | session:<projectId>:<sessionId>, on the first machine
        if let route = ProcessInfo.processInfo.environment["SIDE_ROUTE"]?.split(separator: ":").map(String.init),
           let first = machines.first?.id {
            switch route.first {
            case "projects": tab = .projects
            case "new" where route.count == 2: path = [.newSession(machineId: first, projectId: route[1])]
            case "session" where route.count == 3: path = [.session(SessionRoute(machineId: first, projectId: route[1], sessionId: route[2]))]
            case "browse": path = [.browse(machineId: first)]
            default: break
            }
        }
        #endif
    }

    var paired: Bool { !machines.isEmpty }
    /// Whether the lists mix several machines, and so name each one.
    var multi: Bool { machines.count > 1 }

    func machine(_ id: String) -> Machine? {
        machines.first { $0.id == id }
    }

    private func save() {
        Connection.saveAll(machines.map(\.connection))
    }

    /// Checks the credential before keeping it. Pairing a machine already
    /// paired (same host) replaces its credential rather than listing it twice.
    func connect(_ connection: Connection) async throws {
        let client = HostClient(endpoint: connection.endpoint, token: connection.token)
        let host = try await client.describe()
        var connection = connection
        if let same = machines.first(where: { $0.host?.environmentId == host.environmentId || $0.connection.endpoint == connection.endpoint }) {
            connection.id = same.id
            connection.name = same.connection.name
            machines.removeAll { $0.id == same.id }
        }
        let machine = Machine(connection)
        machine.host = host
        machines.append(machine)
        save()
        await registerPush(machine)
        await refresh(machine)
    }

    func rename(_ machine: Machine, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        machine.rename(trimmed.isEmpty ? nil : trimmed)
        save()
    }

    /// Unpairs a machine from this phone; its sessions keep running on it.
    func remove(_ machine: Machine) async {
        if let apnsToken {
            _ = try? await machine.client.rpc("push.unregisterApns", ["token": apnsToken], as: HostClient.Ignored.self)
        }
        machines.removeAll { $0.id == machine.id }
        save()
        for tab in paths.keys { paths[tab]?.removeAll { $0.machineId == machine.id } }
        if machines.isEmpty {
            paths = [:]
            tab = .now
        }
    }

    func report(_ error: Error, machine: Machine? = nil) {
        if error is HostClient.Unauthorized, let machine {
            self.error = "\(machine.name) signed this phone out. Pair it again from Machines."
        } else if (error as? URLError)?.code != .cancelled, !(error is CancellationError) {
            self.error = error.localizedDescription
        }
    }

    /// For reads that repeat on their own. A phone sleeps and changes network,
    /// so a dropped request waits for the next read instead of raising an
    /// alert; a host that keeps refusing is reported once, after three in a row.
    func reportPoll(_ error: Error, machine: Machine) {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        machine.pollFailures += 1
        if error is URLError { machine.offline = true }
        else if error is HostClient.Unauthorized { machine.offline = true; if machine.pollFailures == 1 { report(error, machine: machine) } }
        else if machine.pollFailures == 3 { report(error, machine: machine) }
    }

    /// A repeating read went through.
    func pollSucceeded(_ machine: Machine) {
        machine.pollFailures = 0
        machine.offline = false
    }

    /// Every machine's host, projects and sessions, at once.
    func refresh() async {
        await withTaskGroup(of: Void.self) { group in
            for machine in machines { group.addTask { await self.refresh(machine) } }
        }
        await checkForUpdate()
    }

    func refresh(_ machine: Machine) async {
        let client = machine.client
        do {
            if machine.host == nil {
                machine.host = try await client.describe()
                await registerPush(machine)
            }
            if machine.catalog == nil { machine.catalog = try? await client.rpc("models.list", as: HostModelCatalog.self) }
            let projects = try await client.rpc("projects.list", as: [HostProject].self).map { project in
                var project = project
                project.machineId = machine.id
                return project
            }
            // A project whose list fails keeps the last one it had: a folder
            // moved on the host must not hide every other session.
            var sessions: [String: [HostSessionSummary]] = [:]
            var failure: Error?
            let previous = machine.sessions
            let id = machine.id
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
                for await (projectId, result) in group {
                    switch result {
                    case .success(let list):
                        sessions[projectId] = list.map { session in
                            var session = session
                            session.machineId = id
                            return session
                        }
                    case .failure(let error):
                        failure = error
                        sessions[projectId] = previous[projectId] ?? []
                    }
                }
            }
            // The credential and the connection are not a project's fault.
            if let failure, failure is HostClient.Unauthorized || failure is URLError { throw failure }
            machine.projects = projects
            machine.sessions = sessions
            machine.accounts = (try? await client.rpc("accounts.list", as: [HostAccountSummary].self)) ?? machine.accounts
            if machine.can("projects.rail") { machine.rail = try? await client.rpc("projects.rail", as: RailState.self) }
            if machine.webApps == nil, machine.can("webApps") {
                machine.webApps = (try? await client.rpc("webApps.get", as: HostWebApps.self))?.apps
            }
            pollSucceeded(machine)
        } catch {
            reportPoll(error, machine: machine)
        }
    }

    // MARK: Lists

    var allSessions: [HostSessionSummary] { machines.flatMap { $0.sessions.values.joined() } }
    var allProjects: [HostProject] { machines.flatMap(\.visibleProjects) }
    /// Machines that could not be read: their sessions are the last known.
    var offlineMachines: [Machine] { machines.filter(\.offline) }

    /// Everything waiting on the user, for the Now tab's badge.
    var waitingCount: Int { toReview.count }

    /// What waits on the user, as the desktop's To review: questions first,
    /// then turns that failed, then done ones to check, each by recency.
    var toReview: [HostSessionSummary] {
        func rank(_ session: HostSessionSummary) -> Int {
            session.needsInput == true ? 0 : session.failedTurn ? 1 : 2
        }
        return allSessions
            .filter { $0.archived != true && !$0.draftOnly && ($0.needsInput == true || $0.done) }
            .sorted { (rank($0), -$0.updatedAt) < (rank($1), -$1.updatedAt) }
    }

    /// Sessions still working, newest first.
    var working: [HostSessionSummary] {
        allSessions
            .filter { $0.archived != true && $0.running && $0.needsInput != true }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Sessions checked on this phone, last checked first. One that works,
    /// waits or is done again leaves the list until it is checked again.
    var checked: [HostSessionSummary] {
        let all = Dictionary(allSessions.map { (CheckedSession.key($0), $0) }, uniquingKeysWith: { a, _ in a })
        return checks
            .compactMap { all[$0.id] }
            .filter { $0.archived != true && !$0.running && $0.needsInput != true && !$0.done }
    }

    func summary(_ route: SessionRoute) -> HostSessionSummary? {
        machine(route.machineId)?.sessions[route.projectId]?.first { $0.id == route.sessionId }
    }

    func project(machineId: String, id: String) -> HostProject? {
        machine(machineId)?.projects.first { $0.id == id }
    }

    /// "Claude Opus 5" rather than "opus", from that machine's catalog.
    func modelName(machineId: String, harness: String, model: String?) -> String {
        machine(machineId)?.modelName(harness: harness, model: model) ?? model ?? harness
    }

    /// A new session in the project worked in last.
    var recentProject: HostProject? {
        let latest = allSessions.max { $0.updatedAt < $1.updatedAt }
        return allProjects.first { $0.id == latest?.projectId && $0.machine == latest?.machine } ?? allProjects.first
    }

    // MARK: Projects

    func setRail(_ machine: Machine, projects: [String], archived: [String]) async {
        do {
            machine.rail = try await machine.client.rpc("projects.setRail", ["projects": projects, "archived": archived], as: RailState.self)
        } catch {
            report(error, machine: machine)
        }
    }

    /// Opens a folder of a machine as a project and lists it, as the desktop's rail does.
    func openProject(_ machine: Machine, cwd: String) async -> HostProject? {
        do {
            var opened = try await machine.client.rpc("projects.open", ["cwd": cwd], as: HostProject.self)
            opened.machineId = machine.id
            if !machine.projects.contains(where: { $0.id == opened.id }) { machine.projects.append(opened) }
            if let rail = machine.rail, !machine.visibleProjects.contains(where: { $0.cwd == opened.cwd }) {
                await setRail(machine, projects: machine.visibleProjects.map(\.cwd) + [opened.cwd], archived: rail.archived.filter { $0 != opened.cwd })
            }
            return opened
        } catch {
            report(error, machine: machine)
            return nil
        }
    }

    func hide(_ project: HostProject) async {
        guard let machine = machine(project.machine) else { return }
        await setRail(
            machine,
            projects: machine.visibleProjects.map(\.cwd).filter { $0 != project.cwd },
            archived: [project.cwd] + (machine.rail?.archived ?? [])
        )
    }

    // MARK: Sessions

    func delete(_ summary: HostSessionSummary) async {
        guard let machine = machine(summary.machine) else { return }
        do {
            _ = try await machine.client.rpc("sessions.delete", ["projectId": summary.projectId, "sessionId": summary.id], as: HostClient.Ignored.self)
            for tab in paths.keys { paths[tab]?.removeAll { $0.sessionId == summary.id } }
            await refresh(machine)
        } catch {
            report(error, machine: machine)
        }
    }

    /// The user checked a done session; it leaves To review and its project's count.
    func markChecked(_ summary: HostSessionSummary) async {
        let key = CheckedSession.key(summary)
        checks = Array(([CheckedSession(id: key)] + checks.filter { $0.id != key }).prefix(50))
        CheckedSession.save(checks)
        await update(summary, ["reviewed": true])
    }

    func update(_ summary: HostSessionSummary, _ patch: [String: Any]) async {
        guard let machine = machine(summary.machine) else { return }
        var params = patch
        params["projectId"] = summary.projectId
        params["sessionId"] = summary.id
        do {
            _ = try await machine.client.rpc("sessions.update", params, as: HostClient.Ignored.self)
            await refresh(machine)
        } catch {
            report(error, machine: machine)
        }
    }

    // MARK: Host accounts

    /// Asks a host to read every account's usage afresh, as the desktop
    /// does when its account menu opens: at most every 20 seconds.
    func refreshAccounts(_ machine: Machine, force: Bool = false) async {
        guard force || Date().timeIntervalSince(machine.accountsRefreshedAt) > 20 else { return }
        machine.accountsRefreshedAt = Date()
        await changeAccounts(machine, machine.can("accounts.refresh") ? "accounts.refresh" : "accounts.list", [:])
    }

    /// Lets the Balanced choice use an account, or stops it.
    func setBalanced(_ machine: Machine, _ account: HostAccountSummary, _ balanced: Bool) async {
        await changeAccounts(machine, "accounts.balance", ["accountId": account.id, "balanced": balanced])
    }

    /// Takes an account off a host.
    func remove(_ machine: Machine, account: HostAccountSummary) async {
        await changeAccounts(machine, "accounts.remove", ["accountId": account.id])
    }

    /// An account call that answers with the accounts after it.
    private func changeAccounts(_ machine: Machine, _ method: String, _ params: [String: Any]) async {
        do {
            machine.accounts = try await machine.client.rpc(method, params, as: [HostAccountSummary].self)
        } catch {
            report(error, machine: machine)
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
        for machine in machines {
            let endpoint = machine.connection.endpoint
            if let published = await manifest(endpoint.appending(path: "ipa/version.json")) {
                found.append(AppUpdate(version: published.version, build: published.number, ipa: endpoint.appending(path: "ipa/SideMobile.ipa")))
            }
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
        Task { for machine in machines { await registerPush(machine) } }
    }

    /// Every machine notifies this phone of its own sessions.
    private func registerPush(_ machine: Machine) async {
        guard let apnsToken, machine.can("push.apns") else { return }
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        _ = try? await machine.client.rpc("push.registerApns", [
            "token": apnsToken, "environment": environment, "bundleId": Bundle.main.bundleIdentifier ?? "",
        ], as: HostClient.Ignored.self)
    }

    /// A tapped notification opens its session, on the machine that runs it.
    func open(projectId: String, sessionId: String, machineId: String? = nil) {
        let machine = machineId
            ?? machines.first { $0.sessions[projectId]?.contains { $0.id == sessionId } == true }?.id
            ?? machines.first { $0.projects.contains { $0.id == projectId } }?.id
            ?? machines.first?.id
        guard let machine else { return }
        tab = .now
        path = [.session(SessionRoute(machineId: machine, projectId: projectId, sessionId: sessionId))]
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

/// A session this phone marked checked, as `machine:session`.
struct CheckedSession: Codable, Hashable {
    let id: String

    /// Kept apart from the single-machine list of older builds.
    private static let key = "home.checked.machines"

    static func key(_ session: HostSessionSummary) -> String { "\(session.machine):\(session.id)" }

    static func load() -> [CheckedSession] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([CheckedSession].self, from: data)) ?? []
    }

    static func save(_ checks: [CheckedSession]) {
        if let data = try? JSONEncoder().encode(checks) { UserDefaults.standard.set(data, forKey: key) }
    }
}
