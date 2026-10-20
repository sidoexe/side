import SwiftUI

/// What Resume sends, as the desktop's `CONTINUE_PROMPT` (inFlight.ts).
let continuePrompt = "Continue from where you left off."

struct SessionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let route: SessionRoute

    @State private var value: HostSession?
    @State private var items: [TranscriptItem] = []
    @State private var catalog: HostModelCatalog?
    @State private var editing = false
    @State private var seed: (text: String, nonce: Int)?
    @State private var renaming = false
    @State private var deleting = false
    /// Follows new output only while the end is on screen.
    @State private var atEnd = true
    @State private var reading = false
    @State private var readAgain = false

    private var summary: HostSessionSummary? { model.summary(route) }
    private var title: String {
        if let value { return displayTitle(value.meta.title, harness: value.meta.harness) }
        return summary?.displayName ?? "Session"
    }

    var body: some View {
        Group {
            if let value {
                transcript(value)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    Text(subtitle).font(Theme.meta).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }.flat()
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 16) {
                    if let summary, summary.done {
                        Button("Mark checked", systemImage: "checkmark.circle") {
                            Task { await model.markChecked(summary) }
                        }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(Theme.addFg)
                    }
                    menu
                }
            }.flat()
        }
        .alert("Rename session", isPresented: $renaming) {
            RenameField(initial: title) { name in
                if let summary { Task { await model.update(summary, ["title": name]) } }
            }
        }
        .confirmationDialog("Delete \"\(title)\"? Its transcript is removed from the host.", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let summary { Task { await model.delete(summary) } }
            }
        }
        .task(id: route) { await poll() }
        .task { await model.refreshAccounts() }
        .task(id: route.projectId) {
            catalog = try? await model.client?.rpc("models.list", ["projectId": route.projectId], as: HostModelCatalog.self)
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let project = model.project(route.projectId) { parts.append(project.name) }
        if let value { parts.append(model.modelName(harness: value.meta.harness, model: value.meta.model)) }
        if let branch = summary?.branch { parts.append(branch) }
        if let account = value?.accountInUse { parts.append(model.accounts.first { $0.id == account }?.label ?? account) }
        return parts.joined(separator: " · ")
    }

    private func transcript(_ value: HostSession) -> some View {
        let running = value.running
        let editable = !running && ["pi", "omp", "codex", "opencode"].contains(value.meta.harness)
            ? value.blocks.last { $0.role == "user" }?.id
            : nil
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(items) { item in
                        TranscriptItemView(
                            item: item,
                            cwd: value.meta.cwd,
                            sessionId: route.sessionId,
                            canDecide: running && value.runId != nil,
                            onDecide: { requestId, decision in
                                run(["type": "approve", "runId": value.runId ?? "", "requestId": requestId, "decision": decision])
                            },
                            editableId: editable,
                            onEdit: { block in
                                editing = true
                                seed = (block.text, (seed?.nonce ?? 0) + 1)
                            },
                            onBuild: running ? nil : { block in
                                run(["type": "send", "text": "Build the approved plan:\n\n\(block.text)", "intent": "build", "planBlockId": block.id])
                            }
                        )
                    }
                    if value.status == "interrupted" {
                        notice("Interrupted")
                    }
                    if let limit = value.meta.usageLimit {
                        usageLimit(limit, value: value)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 20)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self, of: showsEnd) { _, end in atEnd = end }
            .onChange(of: "\(value.blocks.count)-\(value.blocks.last?.text.count ?? 0)") {
                if atEnd { proxy.scrollTo("end", anchor: .bottom) }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 6) {
                    if !atEnd {
                        JumpToEnd { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
                    }
                    if let question = value.meta.pendingQuestion, value.runId != nil {
                        QuestionCard(prompt: question) { reply in
                            run(["type": "answer", "runId": value.runId!, "requestId": question.requestId, "reply": reply])
                        }
                    }
                    queue(value)
                    composer(value)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
                .background(Theme.bg.opacity(0.92).ignoresSafeArea(edges: .bottom))
            }
        }
    }

    private func composer(_ value: HostSession) -> some View {
        let running = value.running
        return ComposerView(
            running: running,
            canPlan: model.can("sessions.plan") && !running,
            seed: seed,
            banner: editing ? "Editing your last message" : nil,
            onCancelBanner: {
                editing = false
                seed = ("", (seed?.nonce ?? 0) + 1)
            },
            onStop: value.runId.map { runId in { run(["type": "cancel", "runId": runId]) } },
            onSend: { outgoing in try await send(outgoing, value) },
            context: {
                Text(tilde(value.meta.worktreeCwd ?? value.meta.cwd)).font(Theme.mono).truncationMode(.head)
                if let branch = summary?.branch {
                    Label(branch, systemImage: "arrow.triangle.branch").font(Theme.mono).labelStyle(.titleAndIcon)
                }
                Spacer(minLength: 0)
                if let ratio = value.meta.context?.ratio { ContextMeter(ratio: ratio) }
            },
            tools: { SessionChips(value: value, catalog: catalog) { change in configure(value, change) } }
        )
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13))
            .foregroundStyle(Theme.delFg)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.del.opacity(0.35)))
    }

    /// As the desktop's `UsageLimitNotice`: Resume once the limit has reset,
    /// or resume at reset (cancellable) before; an account switch; Dismiss.
    private func usageLimit(_ limit: SessionMeta.UsageLimit, value: HostSession) -> some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let waiting = limit.resetsAt.map { $0 > context.date.timeIntervalSince1970 * 1000 } ?? false
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "gauge.with.dots.needle.67percent").foregroundStyle(Theme.amber)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Usage limit reached").foregroundStyle(Theme.text)
                        if let resetsAt = limit.resetsAt {
                            Text(waiting ? "Resets \(resetTime(resetsAt))" : "Limit has reset").foregroundStyle(Theme.muted)
                        }
                    }
                    Spacer(minLength: 0)
                    Button {
                        setUsageLimit(NSNull(), projectId: value.projectId)
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 24, height: 24)
                    }
                    .foregroundStyle(Theme.muted)
                    .accessibilityLabel("Dismiss usage limit notice")
                }
                HStack(spacing: 6) {
                    if !waiting {
                        Button("Resume", systemImage: "play.fill") { run(["type": "send", "text": continuePrompt]) }
                            .buttonStyle(ThemeButtonStyle())
                    } else if limit.resumeAtReset == true {
                        Button("Resuming at reset", systemImage: "clock") {
                            setUsageLimit(["resumeAtReset": false], projectId: value.projectId)
                        }
                        .buttonStyle(ThemeButtonStyle())
                        .accessibilityHint("Cancels the automatic resume")
                    } else {
                        Button("Resume at reset", systemImage: "clock") {
                            setUsageLimit(["resumeAtReset": true], projectId: value.projectId)
                        }
                        .buttonStyle(ThemeButtonStyle())
                    }
                    AccountChip(harness: value.meta.harness, current: value.meta.providerAccountId) { account in
                        configure(value, SessionChips.Change(providerAccountId: account))
                    }
                }
            }
        }
        .font(.system(size: 13))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.amber.opacity(0.06), in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.amber.opacity(0.25)))
    }

    /// `sessions.update` of the usage limit: arms or cancels the resume, or
    /// clears the notice with `NSNull`.
    private func setUsageLimit(_ limit: Any, projectId: String) {
        Task {
            do {
                _ = try await model.client?.rpc("sessions.update", [
                    "projectId": projectId, "sessionId": route.sessionId, "usageLimit": limit,
                ], as: HostClient.Ignored.self)
            } catch {
                model.report(error)
            }
            await refresh()
        }
    }

    @ViewBuilder
    private func queue(_ value: HostSession) -> some View {
        if let queued = value.meta.queuedMessages, !queued.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(queued) { message in
                    HStack(spacing: 8) {
                        Text(message.text).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                        if value.running {
                            Button("Send now") { run(["type": "queueSteer", "messageId": message.id]) }.foregroundStyle(Theme.link)
                        }
                        Button {
                            run(["type": "queueRemove", "messageId": message.id])
                        } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                    }
                    .font(Theme.small)
                    .foregroundStyle(Theme.muted)
                    .padding(.leading, 10)
                    .padding(.trailing, 8)
                    .padding(.vertical, 6)
                    .background(Theme.bg, in: .rect(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.stroke))
                }
                if value.meta.queueStatus == "paused" {
                    Button("Resume queue") { run(["type": "queueResume"]) }.font(Theme.meta).foregroundStyle(Theme.link)
                }
            }
        }
    }

    private var menu: some View {
        Menu {
            if let summary {
                if summary.done {
                    Button("Mark checked", systemImage: "checkmark.circle") { Task { await model.markChecked(summary) } }
                }
                Button("Rename", systemImage: "pencil") { renaming = true }
                Button(summary.pinned == true ? "Unpin" : "Pin", systemImage: "pin") {
                    Task { await model.update(summary, ["pinned": summary.pinned != true]) }
                }
                Button(summary.archived == true ? "Unarchive" : "Archive", systemImage: "archivebox") {
                    Task {
                        await model.update(summary, ["archived": summary.archived != true])
                        if summary.archived != true { dismiss() }
                    }
                }
            }
            Button("Compact context", systemImage: "rectangle.compress.vertical") { run(["type": "compact"]) }
            if summary != nil {
                Button("Delete", systemImage: "trash", role: .destructive) { deleting = true }
            }
        } label: {
            Image(systemName: "ellipsis")
        }
    }

    // MARK: Actions

    private func configure(_ value: HostSession, _ change: SessionChips.Change) {
        var input: [String: Any] = [
            "type": "configure",
            "model": change.model ?? value.meta.model,
            "modelSettings": change.modelSettings ?? value.meta.modelSettings ?? [:],
            "runtimeMode": change.runtimeMode ?? value.meta.runtimeMode,
        ]
        if let account = change.providerAccountId ?? value.meta.providerAccountId { input["providerAccountId"] = account }
        run(input)
    }

    private func send(_ outgoing: Outgoing, _ value: HostSession) async throws {
        guard let client = model.client else { return }
        var input: [String: Any] = ["sessionId": route.sessionId, "text": outgoing.text]
        if !outgoing.attachments.isEmpty { input["attachments"] = outgoing.attachments.map(\.json) }
        if editing {
            input["type"] = "editLast"
            editing = false
        } else {
            input["type"] = value.running || !(value.meta.queuedMessages ?? []).isEmpty ? "queue" : "send"
            if outgoing.plan { input["intent"] = "plan" }
        }
        do {
            try await client.command(input)
            await refresh()
        } catch {
            model.report(error)
            throw error
        }
    }

    private func run(_ input: [String: Any]) {
        guard let client = model.client else { return }
        var input = input
        input["sessionId"] = route.sessionId
        Task {
            do {
                try await client.command(input)
                await refresh()
            } catch {
                model.report(error)
            }
        }
    }

    /// One read at a time: two in flight can finish out of order and put an
    /// older transcript back. One asked for meanwhile, such as after a send,
    /// runs as soon as the first ends.
    private func refresh() async {
        if reading {
            readAgain = true
            return
        }
        reading = true
        defer { reading = false }
        repeat {
            readAgain = false
            guard let client = model.client else { return }
            do {
                let next = try await client.sync(route.sessionId, known: value)
                if next != value {
                    value = next
                    items = TranscriptItem.build(next.blocks, running: next.running)
                }
                model.pollSucceeded()
            } catch {
                model.reportPoll(error)
            }
        } while readAgain && !Task.isCancelled
    }

    /// Quick while a turn runs, slower when idle, as the web client does.
    private func poll() async {
        value = nil
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: value?.running == true ? .milliseconds(750) : .seconds(3))
        }
    }
}

/// The open session's settings as chips: model, effort, permissions and
/// account. A change applies to the next turn, as on the desktop.
struct SessionChips: View {
    struct Change {
        var model: String?
        var modelSettings: [String: String]?
        var runtimeMode: String?
        var providerAccountId: String?
    }

    @Environment(AppModel.self) private var app
    let value: HostSession
    let catalog: HostModelCatalog?
    let onChange: (Change) -> Void

    var body: some View {
        let meta = value.meta
        let models = catalog?.models[meta.harness] ?? []
        let model = models.first { $0.matches(meta.model) }
        Chip(icon: AnyView(HarnessIcon(harness: meta.harness, size: 13)), label: app.modelName(harness: meta.harness, model: meta.model), disabled: models.isEmpty) {
            ForEach(models) { item in
                ChoiceButton(label: item.name, selected: item.matches(meta.model)) { onChange(Change(model: item.id)) }
            }
        }
        if let effort = model?.effort {
            let current = meta.modelSettings?[effort.id] ?? effort.value
            Chip(label: effort.options.first { $0.value == current }?.label ?? current) {
                ForEach(effort.options, id: \.value) { option in
                    ChoiceButton(label: option.label, selected: option.value == current) {
                        var settings = meta.modelSettings ?? [:]
                        settings[effort.id] = option.value
                        onChange(Change(modelSettings: settings))
                    }
                }
            }
        }
        Chip(label: runtimeModes.first { $0.id == meta.runtimeMode }?.label ?? meta.runtimeMode) {
            ForEach(runtimeModes, id: \.id) { mode in
                ChoiceButton(label: mode.label, selected: mode.id == meta.runtimeMode) { onChange(Change(runtimeMode: mode.id)) }
            }
        }
        AccountChip(harness: meta.harness, current: meta.providerAccountId) { onChange(Change(providerAccountId: $0)) }
    }
}

struct QuestionCard: View {
    let prompt: UserQuestionPrompt
    let onReply: ([String: Any]) -> Void
    @State private var answers: [String: [String]] = [:]
    @State private var custom: [String: String] = [:]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let title = prompt.title { Text(title).font(.system(size: 14, weight: .semibold)) }
                ForEach(prompt.questions) { question in
                    VStack(alignment: .leading, spacing: 6) {
                        if let header = question.header { CardLabel(text: header) }
                        Text(question.prompt).font(.system(size: 14, weight: .semibold))
                        ForEach(question.options) { option in
                            let selected = answers[question.id]?.contains(option.id) ?? false
                            Button {
                                toggle(question, option.id)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label).font(.system(size: 14))
                                    if let description = option.description {
                                        Text(description).font(Theme.meta).foregroundStyle(Theme.muted)
                                    }
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(selected ? Theme.accent.opacity(0.18) : .clear, in: .rect(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(selected ? Theme.accent.opacity(0.45) : Theme.stroke))
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                        if question.allowCustom {
                            TextField("Other…", text: Binding(get: { custom[question.id] ?? "" }, set: { custom[question.id] = $0 }))
                                .font(.system(size: 14))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(Theme.fillSubtle, in: .rect(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.stroke))
                        }
                    }
                }
                HStack(spacing: 6) {
                    Spacer()
                    Button("Skip") { onReply(["kind": "skipped"]) }.buttonStyle(ThemeButtonStyle())
                    Button("Answer") { onReply(reply) }.buttonStyle(ThemeButtonStyle(primary: true))
                }
            }
            .padding(12)
        }
        .frame(maxHeight: 380)
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.sidebar, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.strokeStrong))
    }

    private func toggle(_ question: UserQuestion, _ id: String) {
        var selected = answers[question.id] ?? []
        if question.multiSelect {
            if let index = selected.firstIndex(of: id) { selected.remove(at: index) } else { selected.append(id) }
        } else {
            selected = selected == [id] ? [] : [id]
        }
        answers[question.id] = selected
    }

    /// As `buildQuestionReply`: only answered questions, skipped when none.
    private var reply: [String: Any] {
        var nextAnswers: [String: [String]] = [:]
        var nextCustom: [String: String] = [:]
        for question in prompt.questions {
            let selected = answers[question.id] ?? []
            let text = custom[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !selected.isEmpty { nextAnswers[question.id] = selected }
            if question.allowCustom, !text.isEmpty { nextCustom[question.id] = text }
        }
        if nextAnswers.isEmpty && nextCustom.isEmpty { return ["kind": "skipped"] }
        var reply: [String: Any] = ["kind": "answered", "answers": nextAnswers]
        if !nextCustom.isEmpty { reply["custom"] = nextCustom }
        return reply
    }
}
