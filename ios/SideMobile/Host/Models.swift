import Foundation

/// The host protocol (src/features/connections/model/protocol.ts), as far as
/// the phone reads it. Every field the host may omit is optional, and unknown
/// fields are ignored, so a newer host still decodes.

let hostProtocolVersion = 1

struct HostDescriptor: Decodable {
    let protocolVersion: Int
    let environmentId: String
    let name: String
    let providers: [String]
    let capabilities: [String]
    let version: String?
}

struct HostProject: Decodable, Identifiable, Hashable {
    let id: String
    let cwd: String
    let name: String
}

struct HostSessionSummary: Decodable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let title: String
    let harness: String
    let model: String?
    let status: String
    let updatedAt: Double
    let archived: Bool?
    let pinned: Bool?
    let needsInput: Bool?
    let branch: String?
    let draft: Bool?
    let repo: String?
    let cwd: String?
    let worktreeCwd: String?
    /// Its last turn finished and nobody has checked it yet.
    let toReview: Bool?

    var running: Bool { status == "running" }
    var interrupted: Bool { status == "interrupted" }
    /// Finished and waiting to be checked: it stays until marked so.
    var done: Bool { toReview == true && !running && needsInput != true }
}

struct HostAccountSummary: Decodable, Identifiable, Hashable {
    struct Window: Decodable, Hashable { let used: Double? }
    struct Usage: Decodable, Hashable {
        let fiveHour: Window?
        let sevenDay: Window?
        let error: String?
    }
    let id: String
    let provider: String
    let label: String
    /// The accounts an "auto" entry balances across; absent on a real account.
    let pool: [String]?
    let usage: Usage?

    var isPool: Bool { pool != nil }
}

struct ModelSetting: Decodable, Hashable {
    struct Choice: Decodable, Hashable {
        let value: String
        let label: String
    }
    let id: String
    let label: String
    let kind: String
    let value: String
    let options: [Choice]
}

struct AgentModel: Decodable, Identifiable, Hashable {
    let id: String
    let harness: String
    let name: String
    let nativeId: String?
    let settings: [ModelSetting]?

    /// A session keeps "opus" where the catalog says "claude:opus".
    func matches(_ model: String) -> Bool {
        id == model || nativeId == model || id == "\(harness):\(model)"
    }

    /// As `modelEffortSetting`: the select that sets how hard it thinks.
    var effort: ModelSetting? {
        settings?.first { $0.kind == "select" && ["effort", "reasoning", "reasoningEffort", "thinking", "variant"].contains($0.id) }
    }
}

struct HostModelCatalog: Decodable {
    let models: [String: [AgentModel]]
    let errors: [String: String]
}

struct Attachment: Codable, Hashable {
    let id: String
    let name: String
    let mimeType: String
    let kind: String
    let size: Int
}

struct Block: Decodable, Identifiable, Equatable {
    struct Tool: Decodable, Equatable {
        let title: String?
        let kind: String?
        let status: String?
        let detail: String?
        let preview: Preview?
    }
    struct Preview: Decodable, Equatable {
        struct Line: Decodable, Equatable {
            let number: Int?
            let kind: String
            let text: String
        }
        let kind: String?
        let path: String?
        let fileName: String?
        let additions: Int?
        let deletions: Int?
        let query: String?
        let lines: [Line]?
        let output: String?
    }
    struct Approval: Decodable, Equatable {
        let requestId: Int
        let decided: String?
    }
    let id: String
    let role: String
    let text: String
    let streaming: Bool?
    let attachments: [Attachment]?
    let tool: Tool?
    let approval: Approval?
    let `internal`: Bool?
    let draft: Bool?
    let durationMs: Double?
    let taskList: TaskList?
    let plan: Plan?
    let notice: String?

    struct TaskList: Decodable, Equatable {
        struct Item: Decodable, Equatable {
            let text: String
            let status: String
        }
        let items: [Item]
    }
    struct Plan: Decodable, Equatable {
        let status: String?
    }
}

struct UserQuestion: Decodable, Identifiable, Equatable {
    struct Option: Decodable, Identifiable, Equatable {
        let id: String
        let label: String
        let description: String?
    }
    let id: String
    let header: String?
    let prompt: String
    let multiSelect: Bool
    let allowCustom: Bool
    let options: [Option]
}

struct UserQuestionPrompt: Decodable, Equatable {
    let requestId: Int
    let title: String?
    let questions: [UserQuestion]
}

struct QueuedMessage: Decodable, Identifiable, Equatable {
    let id: String
    let text: String
}

/// A session without its blocks: what a sync delta carries.
struct SessionMeta: Decodable, Equatable {
    let id: String
    let harness: String
    let model: String
    let modelSettings: [String: String]?
    let runtimeMode: String
    let providerAccountId: String?
    let title: String
    let cwd: String
    let busy: Bool?
    let pendingQuestion: UserQuestionPrompt?
    let queuedMessages: [QueuedMessage]?
    let queueStatus: String?
    let worktreeCwd: String?
    let context: ContextUsage?
    let usageLimit: UsageLimit?

    struct ContextUsage: Decodable, Equatable {
        let used: Double
        let window: Double?

        var ratio: Double? {
            guard let window, window > 0, used >= 0 else { return nil }
            return min(1, used / window)
        }
    }
    struct UsageLimit: Decodable, Equatable {
        let resetsAt: Double?
        let resumeAtReset: Bool?
    }
}

struct HostSession: Equatable {
    var meta: SessionMeta
    var blocks: [Block]
    var projectId: String
    var revision: Int
    var runId: String?
    var status: String
    var accountInUse: String?

    var running: Bool { status == "running" }
}

/// `sessions.sync`: unchanged, a full snapshot, a delta of changed blocks,
/// or a transfer too large for one response.
enum SessionSync: Decodable {
    case unchanged(revision: Int)
    case snapshot(HostSession)
    case delta(base: Int, value: HostSession, blockIds: [String])
    case chunked(transfer: String, length: Int)

    private enum Keys: String, CodingKey {
        case kind, revision, value, base, blockIds, blocks, transfer, length
    }
    private enum ValueKeys: String, CodingKey {
        case session, projectId, revision, runId, status, accountInUse
    }
    private enum SessionKeys: String, CodingKey { case blocks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "unchanged":
            self = .unchanged(revision: try c.decode(Int.self, forKey: .revision))
        case "chunked":
            self = .chunked(transfer: try c.decode(String.self, forKey: .transfer), length: try c.decode(Int.self, forKey: .length))
        case let kind:
            let v = try c.nestedContainer(keyedBy: ValueKeys.self, forKey: .value)
            let meta = try v.decode(SessionMeta.self, forKey: .session)
            let blocks: [Block]
            if kind == "snapshot" {
                let s = try v.nestedContainer(keyedBy: SessionKeys.self, forKey: .session)
                blocks = try s.decode([Block].self, forKey: .blocks)
            } else {
                blocks = try c.decode([Block].self, forKey: .blocks)
            }
            let session = HostSession(
                meta: meta,
                blocks: blocks,
                projectId: try v.decode(String.self, forKey: .projectId),
                revision: try v.decode(Int.self, forKey: .revision),
                runId: try v.decodeIfPresent(String.self, forKey: .runId),
                status: try v.decode(String.self, forKey: .status),
                accountInUse: try v.decodeIfPresent(String.self, forKey: .accountInUse)
            )
            self = kind == "snapshot"
                ? .snapshot(session)
                : .delta(base: try c.decode(Int.self, forKey: .base), value: session, blockIds: try c.decode([String].self, forKey: .blockIds))
        }
    }

    struct BaseMismatch: Error {}

    /// As `applySessionSync`: throws when a delta does not apply to `known`.
    func apply(to known: HostSession?) throws -> HostSession {
        switch self {
        case .snapshot(let value):
            return value
        case .unchanged(let revision):
            guard let known, known.revision == revision else { throw BaseMismatch() }
            return known
        case .delta(let base, var value, let blockIds):
            guard let known, known.revision == base else { throw BaseMismatch() }
            var byId = Dictionary(known.blocks.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
            for block in value.blocks { byId[block.id] = block }
            value.blocks = try blockIds.map { id in
                guard let block = byId[id] else { throw BaseMismatch() }
                return block
            }
            return value
        case .chunked:
            throw BaseMismatch()
        }
    }
}

struct CommandReceipt: Decodable {
    let commandId: String
    let sessionId: String
    let revision: Int
}

let runtimeModes: [(id: String, label: String)] = [
    ("supervised", "Supervised"),
    ("auto-accept-edits", "Accept edits"),
    ("auto", "Auto"),
    ("full-access", "Full access"),
]

/// A colleague (src/features/monos/model/mono.ts), as the host keeps them.
struct Mono: Decodable, Identifiable, Hashable {
    struct Avatar: Decodable, Hashable {
        let kind: String
        let value: String
    }
    let id: String
    let sessionId: String?
    let name: String?
    let mascot: String
    let color: String
    let avatar: Avatar?
    let projects: [String]

    var displayName: String { name?.isEmpty == false ? name! : mascot.prefix(1).uppercased() + mascot.dropFirst() }
}

struct MonoRoster: Decodable {
    let roster: [Mono]
}

struct MonoFiles: Decodable {
    let soul: String?
    let memory: String
}

/// A message written to a colleague, waiting on the host for a desktop.
struct InboxMessage: Decodable, Identifiable, Equatable {
    let id: String
    let text: String
    /// A request to move the colleague to this account, not a message.
    let account: String?
    let at: Double
    let takenBy: String?
}

/// The accounts the desktop running the colleagues can move them to, and
/// the one each colleague is on.
struct ColleagueAccounts: Decodable, Equatable {
    struct Window: Decodable, Equatable {
        /// Percent of the window used, 0 to 100.
        let used: Double
        /// When it starts over, in Unix milliseconds, if known.
        let resetsAt: Double?
    }
    struct Usage: Decodable, Equatable {
        let session: Window?
        let weekly: Window?
        let updatedAt: Double
    }
    struct Account: Decodable, Identifiable, Equatable {
        let provider: String
        let id: String
        let label: String
        let usage: Usage?
    }
    struct Current: Decodable, Equatable {
        let provider: String
        let account: String
    }
    /// A colleague's state on its desktop.
    struct State: Decodable, Equatable {
        /// `working`, `needs-you` or `idle`.
        let status: String
        let activity: String?
    }
    let accounts: [Account]
    let current: [String: Current]
    let status: [String: State]?
}

struct ColleagueTranscript: Decodable {
    let blocks: [Block]
}

/// The desktop's rail: which projects it lists, in its order.
struct RailState: Decodable, Equatable {
    let projects: [String]
    let archived: [String]
    let backgrounds: [String: Double]
}

struct HostDirectory: Decodable {
    struct Entry: Decodable, Identifiable, Hashable {
        let name: String
        let path: String
        var id: String { path }
    }
    let path: String
    let parent: String?
    let entries: [Entry]
}

let harnessTitles = [
    "claude": "Claude Code", "codex": "Codex", "cursor": "Cursor", "grok": "Grok Build", "opencode": "OpenCode",
    "pi": "Pi", "omp": "omp", "fx": "fx", "hermes": "Hermes Agent", "antigravity": "Antigravity", "devin": "Devin",
]

/// As `sessionDisplayTitle`: without the "claude · " the harness prefixes.
func displayTitle(_ title: String, harness: String) -> String {
    if title.hasPrefix("\(harness) · ") { return String(title.dropFirst(harness.count + 3)) }
    if title.isEmpty || title == harness || title == harnessTitles[harness] { return "New session" }
    return title
}

extension HostSessionSummary {
    var displayName: String { displayTitle(title, harness: harness) }
}
