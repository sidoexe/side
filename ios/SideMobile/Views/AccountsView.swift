import SwiftUI

/// "3:20 PM" today, "Oct 19, 3:20 PM" later: when a window or limit ends.
func resetTime(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    return date.formatted(date: Calendar.current.isDateInToday(date) ? .omitted : .abbreviated, time: .shortened)
}

/// One line under an account in a menu: why it needs the user, or its usage.
func accountStatus(_ account: HostAccountSummary, among accounts: [HostAccountSummary]) -> String {
    if let pool = account.pool {
        let names = pool.compactMap { id in accounts.first { $0.id == id }?.label }
        return names.isEmpty ? "Moves on at a limit" : "Between \(names.joined(separator: ", "))"
    }
    if account.usage?.error != nil { return "Sign-in needed" }
    if let until = account.limitedUntil { return "Limited until \(resetTime(until.timeIntervalSince1970 * 1000))" }
    let windows = [
        account.usage?.fiveHour?.used.map { "5h \(Int($0.rounded()))%" },
        account.usage?.sevenDay?.used.map { "7d \(Int($0.rounded()))%" },
    ].compactMap { $0 }
    return windows.joined(separator: " · ")
}

/// The account chip of a session, as the desktop's host account picker:
/// "Default" or a host account, each with its usage, and the accounts sheet.
struct AccountChip: View {
    @Environment(AppModel.self) private var app
    let machineId: String
    let harness: String
    /// The session's `providerAccountId`; "default" is the Default choice.
    let current: String?
    let onChange: (String) -> Void
    @State private var managing = false

    private var machine: Machine? { app.machine(machineId) }
    private var canAdd: Bool { machine?.canSignIn(provider: harness) == true }

    var body: some View {
        let accounts = (machine?.accounts ?? []).filter { $0.provider == harness }
        let selected = current.flatMap { $0.isEmpty || $0 == "default" ? nil : $0 }
        if !accounts.isEmpty || canAdd {
            Chip(label: accounts.first { $0.id == selected }?.label ?? "Default") {
                ChoiceButton(label: "Default", selected: selected == nil) { onChange("default") }
                    // Menus have no open callback; their rows appear when it opens.
                    .onAppear { Task { if let machine { await app.refreshAccounts(machine) } } }
                ForEach(accounts) { account in
                    Button {
                        onChange(account.id)
                    } label: {
                        if account.id == selected { Image(systemName: "checkmark") }
                        Text(account.label)
                        let status = accountStatus(account, among: accounts)
                        if !status.isEmpty { Text(status) }
                    }
                }
                Divider()
                Button("Accounts…", systemImage: "person.crop.circle") { managing = true }
            }
            .sheet(isPresented: $managing) { if let machine { HostAccountsSheet(machine: machine, provider: harness) } }
        }
    }
}

/// The host's accounts: usage, sign-in errors, the Balanced pool, and
/// signing one in again or adding one, as the desktop's account menu.
struct HostAccountsSheet: View {
    enum SignIn: Hashable {
        case add(provider: String)
        case again(HostAccountSummary)
    }
    struct Found: Decodable, Hashable {
        let configDir: String
        let label: String
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// The machine whose host keeps these accounts.
    let machine: Machine
    /// Only this provider's accounts, or every one.
    var provider: String?
    @State private var signIn: SignIn?
    @State private var removing: HostAccountSummary?
    @State private var found: [Found] = []
    @State private var importing: String?
    @State private var refreshing = false

    private var accounts: [HostAccountSummary] {
        machine.accounts.filter { provider == nil || $0.provider == provider }
    }
    private var claude: Bool { provider == nil || provider == "claude" }
    /// The providers an account can be added for, in this sheet.
    private var addable: [String] {
        ["claude", "codex"].filter { (provider == nil || provider == $0) && machine.canSignIn(provider: $0) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if accounts.isEmpty {
                        Text("No named accounts on this host. Sessions run on its own sign-in.")
                            .font(Theme.small)
                            .foregroundStyle(Theme.muted)
                    }
                    ForEach(accounts) { row($0) }
                    if claude, machine.can("accounts.import"), !found.isEmpty {
                        SectionLabel(text: "Signed in on the host").padding(.horizontal, -16)
                        ForEach(found, id: \.configDir) { entry in
                            Button {
                                Task { await adopt(entry) }
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "arrow.down.circle")
                                    Text(importing == entry.configDir ? "Importing…" : "Import \(entry.label)").lineLimit(1)
                                    Spacer()
                                    Text(entry.configDir).font(Theme.monoSmall).foregroundStyle(Theme.faint).lineLimit(1)
                                }
                                .font(.system(size: 14))
                                .card(padding: 12)
                            }
                            .buttonStyle(.plain)
                            .disabled(importing != nil)
                        }
                    }
                    if !addable.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(addable, id: \.self) { provider in
                                Button(addable.count > 1 ? "Add \(provider == "codex" ? "Codex" : "Claude") account" : "Add account", systemImage: "plus") {
                                    signIn = .add(provider: provider)
                                }
                                .buttonStyle(ThemeButtonStyle())
                            }
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(20)
            }
            .background(Theme.sidebar.ignoresSafeArea())
            .navigationTitle(model.multi ? "\(machine.name) accounts" : "Host accounts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.sidebar, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if machine.can("accounts.refresh") {
                        Button {
                            Task {
                                refreshing = true
                                await model.refreshAccounts(machine, force: true)
                                refreshing = false
                            }
                        } label: {
                            if refreshing { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                        }
                        .disabled(refreshing)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .navigationDestination(item: $signIn) { target in
                switch target {
                case .add(let provider): HostSignInView(machine: machine, provider: provider, account: nil)
                case .again(let account): HostSignInView(machine: machine, provider: account.provider, account: account)
                }
            }
            .confirmationDialog(
                "Remove \"\(removing?.label ?? "")\" from the host's accounts?",
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) {
                    if let account = removing {
                        Task {
                            await model.remove(machine, account: account)
                            await loadFound()
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            await model.refreshAccounts(machine)
            await loadFound()
        }
    }

    /// Signed-in Claude profiles no account declares yet, to import.
    private func loadFound() async {
        guard claude, machine.can("accounts.import") else { return }
        found = (try? await machine.client.rpc("accounts.found", as: [Found].self)) ?? []
    }

    private func row(_ account: HostAccountSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                HarnessIcon(harness: account.provider, size: 14)
                Text(account.label).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Spacer()
                if account.usage?.error != nil {
                    Pill(text: "Sign-in needed", color: Theme.delFg)
                } else if account.limitedUntil != nil {
                    Pill(text: "Limited")
                }
            }
            if account.isPool {
                Text("\(accountStatus(account, among: machine.accounts)) · starts on the most weekly room, moves on at a limit")
                    .font(Theme.meta)
                    .foregroundStyle(Theme.muted)
            } else {
                if let window = account.usage?.fiveHour { windowRow("5h", window) }
                if let window = account.usage?.sevenDay { windowRow("7d", window) }
                if let until = account.limitedUntil {
                    Text("Limited until \(resetTime(until.timeIntervalSince1970 * 1000))")
                        .font(Theme.meta)
                        .foregroundStyle(Theme.amber)
                }
                if let error = account.usage?.error {
                    Text(error).font(Theme.meta).foregroundStyle(Theme.delFg).lineLimit(3)
                }
                if let at = account.usage?.updatedAt {
                    Text("Updated \(Date().timeIntervalSince1970 - at / 1000 < 60 ? "just now" : "\(ago(at)) ago")")
                        .font(Theme.meta)
                        .foregroundStyle(Theme.faint)
                }
                if let balanced = account.balanced, machine.can("accounts.balance") {
                    Toggle(isOn: Binding(get: { balanced }, set: { on in Task { await model.setBalanced(machine, account, on) } })) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Use in Balanced").font(.system(size: 13))
                            Text("Balanced spreads conversations over these accounts").font(Theme.meta).foregroundStyle(Theme.faint)
                        }
                    }
                    .tint(Theme.addFg)
                }
                HStack(spacing: 6) {
                    if machine.canSignIn(provider: account.provider) {
                        Button("Sign in again") { signIn = .again(account) }
                            .buttonStyle(ThemeButtonStyle(primary: account.usage?.error != nil))
                    }
                    if machine.can("accounts.remove") {
                        Button("Remove") { removing = account }.buttonStyle(ThemeButtonStyle(danger: true))
                    }
                }
            }
        }
        .card()
    }

    private func windowRow(_ label: String, _ window: HostAccountSummary.Window) -> some View {
        let used = window.used ?? 0
        return HStack(spacing: 8) {
            Text(label).font(Theme.monoSmall).foregroundStyle(Theme.faint).frame(width: 18, alignment: .leading)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.fill)
                    Capsule().fill(used >= 90 ? Theme.del : used >= 75 ? Theme.amber : Theme.muted)
                        .frame(width: proxy.size.width * min(1, max(0, used / 100)))
                }
            }
            .frame(height: 4)
            Text("\(Int(used.rounded()))%").font(Theme.monoSmall).foregroundStyle(Theme.muted).frame(width: 34, alignment: .trailing)
            if let at = window.resetsAt, at > Date().timeIntervalSince1970 * 1000 {
                Text("resets \(resetTime(at))").font(Theme.meta).foregroundStyle(Theme.faint).lineLimit(1)
            }
        }
    }

    private func adopt(_ entry: Found) async {
        importing = entry.configDir
        defer { importing = nil }
        do {
            _ = try await machine.client.rpc("accounts.import", ["configDir": entry.configDir], as: HostClient.Ignored.self)
            found.removeAll { $0.configDir == entry.configDir }
            await model.refreshAccounts(machine, force: true)
        } catch {
            model.report(error, machine: machine)
        }
    }
}

/// Signs a host account in from the phone. Claude: the host's
/// `claude auth login` offers a link, Safari opens it, and the code the page
/// shows goes back. Codex: the host offers a link and a device code to enter
/// there, and the phone waits for the host to see the sign-in through.
struct HostSignInView: View {
    private enum Step {
        case starting
        case code(loginId: String, url: URL)
        case device(loginId: String, url: URL, userCode: String)
        case failed(String)

        var loginId: String? {
            switch self {
            case .code(let id, _), .device(let id, _, _): id
            default: nil
            }
        }
    }
    private struct Start: Decodable {
        let loginId: String
        let url: String
        /// The device code to enter on the page; Codex only.
        let userCode: String?
    }
    /// `accounts.loginStatus`: still `pending`, or the account signed in.
    private struct Status: Decodable {
        let pending: Bool?
        let accountId: String?
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let machine: Machine
    let provider: String
    /// The account to sign in again, or none to add one.
    let account: HostAccountSummary?
    @State private var step = Step.starting
    @State private var code = ""
    @State private var busy = false
    @State private var finished = false
    @State private var copied = false
    /// Bumped on each start, so a stale poll stops.
    @State private var attempt = 0

    private var providerName: String { provider == "codex" ? "Codex" : "Claude" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(account.map { "Sign \($0.label) in again" } ?? "Add a \(providerName) account")
                    .font(.system(size: 16, weight: .semibold))
                switch step {
                case .starting:
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Asking the host for a sign-in link…").font(Theme.small).foregroundStyle(Theme.muted)
                    }
                case .code(_, let url):
                    Text("Sign in on the page that opened, then paste the code it shows here.")
                        .font(Theme.small)
                        .foregroundStyle(Theme.muted)
                    Button("Open sign-in page", systemImage: "safari") { openURL(url) }
                        .buttonStyle(ThemeButtonStyle())
                    TextField("Code", text: $code)
                        .font(Theme.mono)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(Theme.fillSubtle, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.stroke))
                        .onSubmit { Task { await finish() } }
                    Button(busy ? "Signing in…" : "Sign in") { Task { await finish() } }
                        .buttonStyle(ThemeButtonStyle(primary: true))
                        .disabled(busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                case .device(_, let url, let userCode):
                    Text("Open the sign-in page and enter this code there.")
                        .font(Theme.small)
                        .foregroundStyle(Theme.muted)
                    Button {
                        UIPasteboard.general.string = userCode
                        copied = true
                    } label: {
                        HStack(spacing: 10) {
                            Text(userCode).font(.system(size: 24, weight: .semibold, design: .monospaced)).textSelection(.enabled)
                            Spacer()
                            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(Theme.meta)
                                .foregroundStyle(Theme.muted)
                        }
                        .card()
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Copies the code")
                    Button("Open sign-in page", systemImage: "safari") { openURL(url) }
                        .buttonStyle(ThemeButtonStyle(primary: true))
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Waiting for the sign-in to finish…").font(Theme.meta).foregroundStyle(Theme.muted)
                    }
                case .failed(let message):
                    Text(message).font(Theme.small).foregroundStyle(Theme.delFg)
                    Button("Try again") { Task { await start() } }.buttonStyle(ThemeButtonStyle())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .background(Theme.sidebar.ignoresSafeArea())
        .navigationTitle("Sign in")
        .navigationBarTitleDisplayMode(.inline)
        .task { await start() }
        .onDisappear {
            attempt += 1
            // Leaving midway ends the host's sign-in, as the desktop does.
            if !finished, let loginId = step.loginId {
                Task { _ = try? await machine.client.rpc("accounts.loginCancel", ["loginId": loginId], as: HostClient.Ignored.self) }
            }
        }
    }

    private func start() async {
        let client = machine.client
        attempt += 1
        let current = attempt
        step = .starting
        code = ""
        copied = false
        do {
            let params: [String: Any] = account.map { ["accountId": $0.id, "provider": $0.provider] } ?? ["provider": provider]
            let started = try await client.rpc("accounts.login", params, as: Start.self)
            guard let url = URL(string: started.url) else { throw HostClient.HostError(message: "The host offered no sign-in link") }
            if let userCode = started.userCode {
                step = .device(loginId: started.loginId, url: url, userCode: userCode)
                UIPasteboard.general.string = userCode
                copied = true
                openURL(url)
                await poll(started.loginId, attempt: current)
            } else {
                step = .code(loginId: started.loginId, url: url)
                openURL(url)
            }
        } catch {
            if current == attempt { step = .failed(error.localizedDescription) }
        }
    }

    /// Codex: each `accounts.loginStatus` waits up to about 10 seconds on the
    /// host; asks again while it is pending.
    private func poll(_ loginId: String, attempt current: Int) async {
        let client = machine.client
        while current == attempt, !Task.isCancelled {
            do {
                let status = try await client.rpc("accounts.loginStatus", ["loginId": loginId], as: Status.self)
                guard current == attempt else { return }
                if status.pending == true { continue }
                finished = true
                await model.refreshAccounts(machine, force: true)
                dismiss()
                return
            } catch {
                if current == attempt, !Task.isCancelled { step = .failed(error.localizedDescription) }
                return
            }
        }
    }

    private func finish() async {
        let client = machine.client
        guard case .code(let loginId, _) = step, !busy else { return }
        let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.rpc("accounts.loginCode", ["loginId": loginId, "code": code], as: HostClient.Ignored.self)
            finished = true
            await model.refreshAccounts(machine, force: true)
            dismiss()
        } catch {
            // The host ends the sign-in on a failed code; it starts over.
            step = .failed(error.localizedDescription)
        }
    }
}
