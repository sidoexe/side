import SwiftUI

/// One row of the transcript: a block shown on its own, or a run of tool
/// calls, thinking and interim notes folded into a single "Worked" line.
enum TranscriptItem: Identifiable {
    case block(Block)
    case activity(id: String, blocks: [Block], worked: Double?, live: Bool)

    var id: String {
        switch self {
        case .block(let block): block.id
        case .activity(let id, _, _, _): "activity-\(id)"
        }
    }

    /// As the web transcript groups a turn: its last assistant message
    /// stands alone, everything that led to it folds away.
    static func build(_ blocks: [Block], running: Bool) -> [TranscriptItem] {
        var turns: [[Block]] = []
        for block in blocks where block.internal != true && !block.hiddenTool {
            if block.role == "user" || block.role == "handoff" || turns.isEmpty { turns.append([]) }
            turns[turns.count - 1].append(block)
        }
        var items: [TranscriptItem] = []
        for (index, turn) in turns.enumerated() {
            let live = running && index == turns.count - 1
            let final = turn.lastIndex { $0.role == "assistant" }
            let worked = turn.first?.role == "user" ? turn.first?.durationMs : nil
            var pending: [Block] = []
            var groups: [Int] = []
            func flush() {
                guard let first = pending.first else { return }
                groups.append(items.count)
                items.append(.activity(id: first.id, blocks: pending, worked: nil, live: live))
                pending = []
            }
            for (offset, block) in turn.enumerated() {
                if block.role == "reasoning" || block.role == "tool" || (block.role == "assistant" && offset != final) {
                    pending.append(block)
                } else {
                    flush()
                    items.append(.block(block))
                }
            }
            flush()
            // Only the turn's last fold says how long the turn took, and only
            // the last one still runs.
            for (n, at) in groups.enumerated() {
                guard case .activity(let id, let blocks, _, _) = items[at] else { continue }
                let last = n == groups.count - 1
                items[at] = .activity(id: id, blocks: blocks, worked: last ? worked : nil, live: live && last && at == items.count - 1)
            }
        }
        return items
    }
}

extension Block {
    /// Todo edits show as the tasks card, not as calls (`isHiddenTool`).
    var hiddenTool: Bool { role == "tool" && tool?.kind?.lowercased() == "tasks" }

    var failed: Bool { ["failed", "error", "errored"].contains(tool?.status ?? "") }
    var inFlight: Bool { streaming == true || ["in_progress", "pending"].contains(tool?.status ?? "") }

    /// As `toolCallLabel`, simplified: the agent's title, else its target.
    func toolLabel(cwd: String) -> String {
        let preview = tool?.preview
        let path = preview?.path.map { $0.hasPrefix(cwd + "/") ? String($0.dropFirst(cwd.count + 1)) : $0 } ?? preview?.fileName
        let title = (text.isEmpty ? tool?.title : text) ?? ""
        if !title.isEmpty {
            if let path, !title.contains(path), let verb = verb { return "\(verb) \(path)" }
            return title
        }
        if let path { return "\(verb ?? "Open") \(path)" }
        if let query = preview?.query { return "Search \(query)" }
        return "Working"
    }

    private var verb: String? {
        switch (tool?.preview?.kind ?? tool?.kind)?.lowercased() {
        case "read": "Read"
        case "write", "edit": "Edit"
        case "search": "Search"
        default: nil
        }
    }

    var category: String {
        let kind = tool?.kind?.lowercased() ?? ""
        let preview = tool?.preview?.kind
        if preview == "write" || ["edit", "write", "delete", "move"].contains(kind) || (tool?.preview?.additions ?? 0) + (tool?.preview?.deletions ?? 0) > 0 { return "edit" }
        if preview == "read" || kind == "read" { return "read" }
        if preview == "search" || ["search", "fetch"].contains(kind) { return "search" }
        if preview == "shell" || ["execute", "shell", "bash"].contains(kind) { return "run" }
        if kind == "agent" || kind == "task" { return "agent" }
        return "other"
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem
    var cwd = ""
    /// The session the blocks belong to, to read the images sent in them.
    var sessionId = ""
    var canDecide = false
    var onDecide: (Int, String) -> Void = { _, _ in }
    var editableId: String?
    var onEdit: ((Block) -> Void)?
    var onBuild: ((Block) -> Void)?

    var body: some View {
        switch item {
        case .block(let block):
            BlockView(block: block, sessionId: sessionId, canDecide: canDecide, onDecide: onDecide, editable: block.id == editableId, onEdit: onEdit, onBuild: onBuild)
        case .activity(_, let blocks, let worked, let live):
            ActivityView(blocks: blocks, cwd: cwd, worked: worked, live: live)
        }
    }
}

struct BlockView: View {
    let block: Block
    var sessionId = ""
    let canDecide: Bool
    let onDecide: (Int, String) -> Void
    var editable = false
    var onEdit: ((Block) -> Void)?
    var onBuild: ((Block) -> Void)?

    var body: some View {
        switch block.role {
        case "user":
            VStack(alignment: .leading, spacing: 4) {
                if !block.text.isEmpty {
                    Text(block.text).font(.system(size: 15)).textSelection(.enabled)
                }
                if let attachments = block.attachments, !attachments.isEmpty {
                    // Images show as the desktop shows them; the rest by name.
                    ForEach(attachments.filter { $0.kind == "image" && !sessionId.isEmpty }, id: \.id) { attachment in
                        AttachmentImage(sessionId: sessionId, attachment: attachment)
                    }
                    HStack(spacing: 6) {
                        ForEach(attachments.filter { !($0.kind == "image" && !sessionId.isEmpty) }, id: \.id) { attachment in
                            Label(attachment.name, systemImage: attachment.kind == "image" ? "photo" : "doc").lineLimit(1)
                        }
                    }
                    .font(Theme.meta)
                    .foregroundStyle(Theme.muted)
                }
                if editable, let onEdit {
                    Button("Edit") { onEdit(block) }.font(Theme.meta).foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(block.draft == true ? Color.clear : Theme.fillSubtle, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.strokeStrong, style: StrokeStyle(lineWidth: 1, dash: block.draft == true ? [4, 3] : [])))
        case "assistant":
            MarkdownView(text: block.text)
        case "approval":
            ApprovalCard(block: block, canDecide: canDecide, onDecide: onDecide)
        case "tasks":
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array((block.taskList?.items ?? []).enumerated()), id: \.offset) { _, task in
                    HStack(spacing: 8) {
                        TaskMark(status: task.status)
                        Text(task.text)
                            .font(Theme.small)
                            .foregroundStyle(task.status == "completed" || task.status == "cancelled" ? Theme.muted : Theme.text)
                            .strikethrough(task.status == "completed" || task.status == "cancelled", color: Theme.muted)
                    }
                }
            }
            .card(padding: 10, radius: 8)
        case "plan":
            VStack(alignment: .leading, spacing: 8) {
                CardLabel(text: "Plan")
                MarkdownView(text: block.text)
                if block.plan?.status == "ready", let onBuild {
                    HStack {
                        Spacer()
                        Button("Build") { onBuild(block) }.buttonStyle(ThemeButtonStyle(primary: true))
                    }
                } else if let status = block.plan?.status, status == "building" || status == "built" {
                    Text(status == "built" ? "Built" : "Building…").font(Theme.meta).foregroundStyle(Theme.muted)
                }
            }
            .card(padding: 12, radius: 8)
        case "system", "handoff":
            if !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if block.notice == "error" || block.notice == "interrupt" {
                    Text(block.text)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.delFg)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.del.opacity(0.35)))
                } else {
                    Text(block.text).font(.system(size: 13)).foregroundStyle(Theme.muted)
                }
            }
        case "image":
            // The file stays on the machine that made it; say that it exists.
            Label(block.image?.alt ?? block.image?.name ?? "Generated image", systemImage: "photo")
                .font(.system(size: 13))
                .foregroundStyle(Theme.muted)
                .lineLimit(2)
        default:
            EmptyView()
        }
    }
}

/// An image sent in a session, read from the host once and kept.
struct AttachmentImage: View {
    @Environment(AppModel.self) private var model
    let sessionId: String
    let attachment: Attachment
    @State private var image: UIImage?
    @State private var failed = false

    private static let cache = NSCache<NSString, UIImage>()
    private var key: NSString { "\(sessionId)/\(attachment.id)" as NSString }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 240, alignment: .leading)
                    .clipShape(.rect(cornerRadius: 6))
            } else if failed {
                Label(attachment.name, systemImage: "photo").lineLimit(1).font(Theme.meta).foregroundStyle(Theme.muted)
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 60)
            }
        }
        .task(id: attachment.id) {
            if let cached = Self.cache.object(forKey: key) { return image = cached }
            guard let client = model.client else { return }
            do {
                let data = try await client.image(sessionId: sessionId, attachment: attachment)
                guard let decoded = UIImage(data: data) else { return failed = true }
                Self.cache.setObject(decoded, forKey: key)
                image = decoded
            } catch {
                failed = true
            }
        }
    }
}

struct TaskMark: View {
    let status: String

    var body: some View {
        ZStack {
            Circle().strokeBorder(status == "pending" ? Theme.faint : status == "in_progress" ? Theme.text : Theme.muted, lineWidth: 1.5)
            if status == "completed" { Circle().fill(Theme.muted) }
            if status == "in_progress" {
                Circle().trim(from: 0, to: 0.5).fill(Theme.text).rotationEffect(.degrees(-90))
            }
        }
        .frame(width: 11, height: 11)
    }
}

struct CardLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.66)
            .foregroundStyle(Theme.muted)
    }
}

struct ApprovalCard: View {
    let block: Block
    let canDecide: Bool
    let onDecide: (Int, String) -> Void
    @State private var decided = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(block.tool?.title ?? (block.text.isEmpty ? "Permission requested" : block.text))
                .font(.system(size: 15, weight: .medium))
            if let detail = block.tool?.detail, !detail.isEmpty {
                CodeBox(text: detail, maxHeight: 220)
            }
            if let decided = block.approval?.decided {
                Text(decided == "allow" ? "Allowed" : decided == "deny" ? "Denied" : "Cancelled")
                    .font(Theme.meta).foregroundStyle(Theme.muted)
            } else if canDecide, let approval = block.approval {
                HStack(spacing: 6) {
                    Spacer()
                    Button("Deny") { decided += 1; onDecide(approval.requestId, "deny") }.buttonStyle(ThemeButtonStyle())
                    Button("Allow") { decided += 1; onDecide(approval.requestId, "allow") }.buttonStyle(ThemeButtonStyle(primary: true))
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.amber.opacity(0.45)))
        .sensoryFeedback(.success, trigger: decided)
    }
}

/// Monospaced output in a faint box that scrolls both ways.
struct CodeBox: View {
    let text: String
    var maxHeight: CGFloat = 260

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text.count > 20_000 ? String(text.prefix(20_000)) + "\n…" : text)
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(Theme.text)
                .textSelection(.enabled)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.fillSubtle, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.stroke))
    }
}

struct Chevron: View {
    let open: Bool

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.faint)
            .rotationEffect(.degrees(open ? 90 : 0))
    }
}

struct ActivityView: View {
    let blocks: [Block]
    var cwd = ""
    let worked: Double?
    let live: Bool
    @State private var open = false

    /// As `workSummaryLine`: what the calls add up to.
    private var summary: String {
        if let worked, !live { return "Worked for \(duration(worked))" }
        let tools = blocks.filter { $0.role == "tool" }
        if tools.isEmpty { return live ? "Thinking" : "Thought" }
        var order: [String] = []
        var edits = Set<String>(), reads = Set<String>()
        var searches = 0, runs = 0, agents = 0, others = 0
        for block in tools {
            let category = block.category
            if !order.contains(category) { order.append(category) }
            let target = block.tool?.preview?.path ?? block.tool?.preview?.fileName ?? block.id
            switch category {
            case "edit": edits.insert(target)
            case "read": reads.insert(target)
            case "search": searches += 1
            case "run": runs += 1
            case "agent": agents += 1
            default: others += 1
            }
        }
        let current = live ? tools.last?.category : nil
        func files(_ set: Set<String>) -> String { set.count == 1 ? (set.first.map(folderName) ?? "a file") : "\(set.count) files" }
        return order.map { kind in
            let now = kind == current
            switch kind {
            case "edit": return "\(now ? "Editing" : "Edited") \(files(edits))"
            case "read": return "\(now ? "Reading" : "Read") \(files(reads))"
            case "search": return now ? "Searching the project" : "Searched the project"
            case "run": return runs == 1 ? (now ? "Running a command" : "Ran a command") : "\(now ? "Running" : "Ran") \(runs) commands"
            case "agent": return agents == 1 ? (now ? "Running a subagent" : "Ran a subagent") : "Ran \(agents) subagents"
            default: return others == 1 ? "1 step" : "\(others) steps"
            }
        }
        .joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    if worked != nil && !live {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
                    }
                    Text(summary).lineLimit(1).shimmer(live)
                    Chevron(open: open)
                }
                .font(.system(size: 14))
                .foregroundStyle(Theme.muted)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(blocks) { block in
                        switch block.role {
                        case "tool": ToolRow(block: block, cwd: cwd)
                        case "reasoning" where !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                            MarkdownView(text: block.text, size: 13).foregroundStyle(Theme.muted)
                        case "assistant": MarkdownView(text: block.text, size: 13).foregroundStyle(Theme.muted)
                        default: EmptyView()
                        }
                    }
                }
                .padding(.leading, 12)
                .padding(.vertical, 2)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.strokeStrong).frame(width: 1) }
                .padding(.leading, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func duration(_ ms: Double) -> String {
        let seconds = Int((ms / 1000).rounded())
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }
}

struct ToolRow: View {
    let block: Block
    var cwd = ""
    @State private var open = false

    private var output: String { block.tool?.preview?.output ?? block.tool?.detail ?? "" }
    private var diff: Bool {
        let preview = block.tool?.preview
        return !(preview?.lines?.isEmpty ?? true) && ((preview?.additions ?? 0) + (preview?.deletions ?? 0)) > 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 6) {
                    Text(block.toolLabel(cwd: cwd))
                        .font(Theme.mono)
                        .foregroundStyle(block.failed ? Theme.delFg : Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .shimmer(block.inFlight)
                    if let additions = block.tool?.preview?.additions, additions > 0 {
                        Text("+\(additions)").font(Theme.mono).foregroundStyle(Theme.addFg)
                    }
                    if let deletions = block.tool?.preview?.deletions, deletions > 0 {
                        Text("−\(deletions)").font(Theme.mono).foregroundStyle(Theme.delFg)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!diff && output.isEmpty)
            if open {
                if diff {
                    DiffCard(block: block, cwd: cwd)
                } else if !output.isEmpty {
                    CodeBox(text: output)
                }
            }
        }
    }
}

struct DiffCard: View {
    let block: Block
    var cwd = ""

    var body: some View {
        let preview = block.tool?.preview
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(preview?.path.map { $0.replacingOccurrences(of: cwd + "/", with: "") } ?? preview?.fileName ?? "")
                    .font(Theme.mono).lineLimit(1).truncationMode(.head)
                Spacer()
                if let additions = preview?.additions, additions > 0 { Text("+\(additions)").font(Theme.mono).foregroundStyle(Theme.addFg) }
                if let deletions = preview?.deletions, deletions > 0 { Text("−\(deletions)").font(Theme.mono).foregroundStyle(Theme.delFg) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Theme.fillSubtle)
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array((preview?.lines ?? []).prefix(60).enumerated()), id: \.offset) { _, line in
                        HStack(spacing: 0) {
                            Text(line.number.map(String.init) ?? "").frame(width: 34, alignment: .trailing).padding(.trailing, 8).foregroundStyle(Theme.faint)
                            Text(line.kind == "add" ? "+" : line.kind == "del" ? "−" : " ").frame(width: 12, alignment: .leading).foregroundStyle(Theme.muted)
                            Text(line.text).foregroundStyle(Theme.text).fixedSize()
                            Spacer(minLength: 10)
                        }
                        .font(.system(size: 11.5, design: .monospaced))
                        .padding(.vertical, 1)
                        .background(line.kind == "add" ? Theme.add.opacity(0.12) : line.kind == "del" ? Theme.del.opacity(0.12) : .clear)
                        .overlay(alignment: .leading) {
                            if line.kind != "context" { Rectangle().fill(line.kind == "add" ? Theme.add : Theme.del).frame(width: 2) }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .clipShape(.rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.strokeStrong))
    }
}

/// Agent replies as the desktop renders Markdown: headings, lists,
/// quotes, tables and fenced code, inline code and links.
struct MarkdownView: View {
    let text: String
    var size: CGFloat = 15

    private enum Part: Hashable {
        case paragraph(String)
        case heading(level: Int, text: String)
        case item(marker: String, indent: Int, text: String)
        case quote(String)
        case code(String)
        case table([String])
        case rule
    }

    private var parts: [Part] {
        var parts: [Part] = []
        var paragraph: [String] = []
        var code: [String]?
        var table: [String] = []
        func flush() {
            if !paragraph.isEmpty { parts.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
            if !table.isEmpty { parts.append(.table(table)) }
            table = []
        }
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                if let lines = code {
                    parts.append(.code(lines.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
                continue
            }
            if code != nil {
                code!.append(line)
                continue
            }
            if trimmed.isEmpty {
                flush()
            } else if trimmed.hasPrefix("|") {
                if !paragraph.isEmpty { parts.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
                if trimmed.range(of: #"^\|[\s:|-]+\|?$"#, options: .regularExpression) == nil { table.append(trimmed) }
            } else if let heading = trimmed.firstMatch(of: /^(#{1,6})\s+(.*)$/) {
                flush()
                parts.append(.heading(level: heading.1.count, text: String(heading.2)))
            } else if trimmed.range(of: #"^([-*_])\s*(\1\s*){2,}$"#, options: .regularExpression) != nil {
                flush()
                parts.append(.rule)
            } else if let item = line.firstMatch(of: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/) {
                flush()
                let marker = String(item.2)
                parts.append(.item(marker: marker.first?.isNumber == true ? marker : "•", indent: item.1.count / 2, text: String(item.3)))
            } else if trimmed.hasPrefix(">") {
                flush()
                parts.append(.quote(String(trimmed.drop(while: { $0 == ">" || $0 == " " }))))
            } else {
                paragraph.append(line)
            }
        }
        if let lines = code { parts.append(.code(lines.joined(separator: "\n"))) }
        flush()
        return parts
    }

    var body: some View {
        VStack(alignment: .leading, spacing: size * 0.6) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .paragraph(let text):
                    inline(text)
                case .heading(_, let text):
                    inline(text).fontWeight(.semibold).padding(.top, size * 0.3)
                case .item(let marker, let indent, let text):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).foregroundStyle(Theme.muted).frame(minWidth: 12, alignment: .trailing)
                        inline(text)
                    }
                    .padding(.leading, CGFloat(indent) * 16)
                case .quote(let text):
                    inline(text)
                        .foregroundStyle(Theme.muted)
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) { Rectangle().fill(Theme.strokeStrong).frame(width: 2) }
                case .code(let code):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(code)
                            .font(.system(size: 12, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.fillSubtle, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.stroke))
                case .table(let rows):
                    let widths = columnWidths(rows)
                    ScrollView(.horizontal, showsIndicators: false) {
                        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                                if index > 0 { Divider().overlay(Theme.strokeStrong) }
                                GridRow {
                                    ForEach(Array(cells(row).enumerated()), id: \.offset) { column, cell in
                                        // A set width lets a long cell wrap and its row grow,
                                        // rather than end in "…" or spill over the next row.
                                        inline(cell)
                                            .font(.system(size: size - 2, weight: index == 0 ? .semibold : .regular))
                                            .fixedSize(horizontal: false, vertical: true)
                                            .frame(width: column < widths.count ? widths[column] : Self.cellMax, alignment: .leading)
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 5)
                                    }
                                }
                                .background(index == 0 ? Theme.fillSubtle : .clear)
                            }
                        }
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.strokeStrong))
                        .clipShape(.rect(cornerRadius: 6))
                    }
                case .rule:
                    Rectangle().fill(Theme.stroke).frame(height: 1)
                }
            }
        }
        .font(.system(size: size))
        .lineSpacing(size * 0.25)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private static let cellMax: CGFloat = 240

    /// Each column as wide as its widest cell's text on one line, up to `cellMax`.
    private func columnWidths(_ rows: [String]) -> [CGFloat] {
        var widths: [CGFloat] = []
        for (index, row) in rows.enumerated() {
            let font = UIFont.systemFont(ofSize: size - 2, weight: index == 0 ? .semibold : .regular)
            for (column, cell) in cells(row).enumerated() {
                // Code spans are set in a wider monospaced face.
                let plain = cell.replacingOccurrences(of: #"[*_`]"#, with: "", options: .regularExpression)
                let code = cell.contains("`") ? 1.25 : 1
                let width = min(Self.cellMax, ceil((plain as NSString).size(withAttributes: [.font: font]).width * code) + 1)
                if column < widths.count { widths[column] = max(widths[column], width) } else { widths.append(width) }
            }
        }
        return widths
    }

    private func cells(_ row: String) -> [String] {
        var value = row.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var value = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        for run in value.runs {
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                value[run.range].font = .system(size: size * 0.88, design: .monospaced)
                value[run.range].backgroundColor = Theme.fill
            }
            if run.link != nil {
                value[run.range].foregroundColor = Theme.link
            }
        }
        return Text(value)
    }
}
