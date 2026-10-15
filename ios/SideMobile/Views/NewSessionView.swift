import SwiftUI

/// The IDE's empty session: the project's name over a composer whose chips
/// pick the project, agent and model, permissions and account.
struct NewSessionView: View {
    @Environment(AppModel.self) private var model
    let projectId: String

    @State private var current = ""
    @AppStorage("new.harness") private var harness = "claude"
    @AppStorage("new.model") private var modelId = ""
    @AppStorage("new.mode") private var mode = "supervised"
    @State private var account = ""
    @State private var catalog: HostModelCatalog?

    private var project: HostProject? { model.project(current.isEmpty ? projectId : current) }
    private var harnesses: [String] { (model.host?.providers ?? []).filter { !(catalog?.models[$0] ?? []).isEmpty } }
    private var selected: AgentModel? { catalog?.models[harness]?.first { $0.id == modelId } }
    private var accounts: [HostAccountSummary] { model.accounts.filter { $0.provider == harness } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Spacer()
            if let project {
                HStack(spacing: 10) {
                    MascotView(seed: folderName(project.cwd), size: 18)
                    Text(project.name).font(.system(size: 22, weight: .semibold)).lineLimit(1)
                }
                .padding(.horizontal, 10)
            }
            ComposerView(
                placeholder: "Ask, build, plan…",
                disabled: selected == nil,
                canPlan: model.can("sessions.plan"),
                onSend: { outgoing in try await create(outgoing) },
                context: {
                    if let project { Text(tilde(project.cwd)).font(Theme.mono).truncationMode(.head) }
                },
                tools: { chips }
            )
            if let error = catalog?.errors[harness] {
                Text(error).font(Theme.meta).foregroundStyle(Theme.delFg).padding(.horizontal, 10)
            }
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 12)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("New session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .task(id: project?.id) { await load() }
    }

    @ViewBuilder
    private var chips: some View {
        let projects = model.visibleProjects
        if projects.count > 1, let project {
            Chip(icon: AnyView(MascotView(seed: folderName(project.cwd), size: 11)), label: project.name) {
                ForEach(projects) { item in
                    ChoiceButton(label: item.name, selected: item.id == project.id) { current = item.id }
                }
            }
        }
        Chip(
            icon: AnyView(HarnessIcon(harness: harness, size: 13)),
            label: selected?.name ?? (catalog == nil ? "Loading…" : "No models"),
            disabled: harnesses.isEmpty
        ) {
            ForEach(harnesses, id: \.self) { provider in
                Section(provider.capitalized) {
                    ForEach(catalog?.models[provider] ?? []) { item in
                        ChoiceButton(label: item.name, selected: provider == harness && item.id == modelId) {
                            harness = provider
                            modelId = item.id
                            account = ""
                        }
                    }
                }
            }
        }
        Chip(label: runtimeModes.first { $0.id == mode }?.label ?? mode) {
            ForEach(runtimeModes, id: \.id) { item in
                ChoiceButton(label: item.label, selected: item.id == mode) { mode = item.id }
            }
        }
        if !accounts.isEmpty {
            Chip(label: accounts.first { $0.id == account }?.label ?? "Default") {
                ChoiceButton(label: "Default", selected: account.isEmpty) { account = "" }
                ForEach(accounts) { item in
                    ChoiceButton(label: item.label, selected: item.id == account) { account = item.id }
                }
            }
        }
    }

    private func load() async {
        guard let client = model.client, let project else { return }
        do {
            catalog = try await client.rpc("models.list", ["projectId": project.id], as: HostModelCatalog.self)
            if !harnesses.contains(harness) { harness = harnesses.contains("claude") ? "claude" : harnesses.first ?? harness }
            let models = catalog?.models[harness] ?? []
            if !models.contains(where: { $0.id == modelId }) { modelId = models.first?.id ?? "" }
            if !accounts.contains(where: { $0.id == account }) { account = accounts.first { $0.isPool }?.id ?? "" }
        } catch {
            model.report(error)
        }
    }

    private func create(_ outgoing: Outgoing) async throws {
        guard let client = model.client, let project, !modelId.isEmpty else { return }
        do {
            var input: [String: Any] = [
                "type": "create", "projectId": project.id, "harness": harness, "model": modelId, "runtimeMode": mode,
            ]
            if !account.isEmpty { input["providerAccountId"] = account }
            let receipt = try await client.command(input)
            var message: [String: Any] = ["type": "send", "sessionId": receipt.sessionId, "text": outgoing.text]
            if !outgoing.attachments.isEmpty { message["attachments"] = outgoing.attachments.map(\.json) }
            if outgoing.plan { message["intent"] = "plan" }
            try await client.command(message)
            await model.refresh()
            // The new session replaces this screen, as on the desktop.
            if !model.path.isEmpty { model.path.removeLast() }
            model.path.append(.session(SessionRoute(projectId: project.id, sessionId: receipt.sessionId)))
        } catch {
            model.report(error)
            throw error
        }
    }
}

/// Picks a folder of the host and opens it as a project.
struct FolderBrowserView: View {
    @Environment(AppModel.self) private var model
    @State private var directory: HostDirectory?
    @State private var opening = false

    var body: some View {
        List {
            if let directory {
                Section {
                    if let parent = directory.parent {
                        Button { Task { await load(parent) } } label: {
                            Label("..", systemImage: "arrow.turn.left.up").foregroundStyle(Theme.muted)
                        }
                    }
                    ForEach(directory.entries) { entry in
                        Button { Task { await load(entry.path) } } label: {
                            HStack(spacing: 10) {
                                MascotView(seed: entry.name, size: 12)
                                Text(entry.name).foregroundStyle(entry.name.hasPrefix(".") ? Theme.muted : Theme.text)
                            }
                        }
                    }
                } header: {
                    Text(tilde(directory.path)).font(Theme.mono).textCase(nil)
                }
                .listRowBackground(Theme.sidebar)
            } else {
                ProgressView()
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Open folder")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Open") {
                    guard let path = directory?.path else { return }
                    Task {
                        opening = true
                        defer { opening = false }
                        if let project = await model.openProject(cwd: path) {
                            model.path = [.newSession(projectId: project.id)]
                        }
                    }
                }
                .disabled(directory == nil || opening)
            }
        }
        .task { if directory == nil { await load(nil) } }
    }

    private func load(_ path: String?) async {
        guard let client = model.client else { return }
        do {
            var params: [String: Any] = [:]
            if let path { params["path"] = path }
            directory = try await client.rpc("projects.browse", params, as: HostDirectory.self)
        } catch {
            model.report(error)
        }
    }
}
