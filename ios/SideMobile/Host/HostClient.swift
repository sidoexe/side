import Foundation

/// Talks to a sIDE Host at `/rpc` with a paired device credential, as the
/// desktop does. Native requests carry no Origin, which the host requires.
actor HostClient {
    struct Unauthorized: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    struct HostError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    let endpoint: URL
    private let token: String
    private var environmentId = ""
    private let session: URLSession

    init(endpoint: URL, token: String) {
        self.endpoint = endpoint
        self.token = token
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.httpCookieStorage = nil
        session = URLSession(configuration: configuration)
    }

    private struct Envelope<T: Decodable>: Decodable {
        let result: T?
        let error: String?
    }

    /// For results the caller ignores.
    struct Ignored: Decodable {
        init(from decoder: Decoder) throws {}
    }

    func rpc<T: Decodable>(_ method: String, _ params: [String: Any] = [:], as type: T.Type = T.self) async throws -> T {
        // Every call names the host it expects; learn it first.
        if environmentId.isEmpty && method != "environment.describe" { _ = try await describe() }
        var request = URLRequest(url: endpoint.appending(path: "rpc"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "version": hostProtocolVersion,
            "environmentId": environmentId,
            "method": method,
            "params": params,
        ])
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let error = (try? JSONDecoder().decode(Envelope<Ignored>.self, from: data))?.error
            if status == 401 { throw Unauthorized(message: error ?? "Signed out") }
            throw HostError(message: error ?? "HTTP \(status)")
        }
        let envelope = try JSONDecoder().decode(Envelope<T>.self, from: data)
        if let result = envelope.result { return result }
        if let error = envelope.error { throw HostError(message: error) }
        // A `null` or missing result: fine for optional results and `Ignored`.
        return try JSONDecoder().decode(T.self, from: Data("null".utf8))
    }

    func describe() async throws -> HostDescriptor {
        let host = try await rpc("environment.describe", ["supportedProviders": supportedProviders], as: HostDescriptor.self)
        guard host.protocolVersion == hostProtocolVersion else {
            throw HostError(message: "This machine is running an incompatible sIDE Host")
        }
        environmentId = host.environmentId
        return host
    }

    // MARK: Sessions

    private struct Chunk: Decodable { let data: String? }

    private func readSync(_ sessionId: String, revision: Int?) async throws -> SessionSync {
        var params: [String: Any] = ["sessionId": sessionId]
        if let revision { params["revision"] = revision }
        let sync = try await rpc("sessions.sync", params, as: SessionSync.self)
        guard case .chunked(let transfer, let length) = sync else { return sync }
        // `length` and offsets count UTF-16 code units, as JavaScript does.
        var pieces: [String] = []
        var offset = 0
        while offset < length {
            let chunk = try await rpc("sessions.syncChunk", ["sessionId": sessionId, "transfer": transfer, "offset": offset], as: Chunk.self)
            guard let data = chunk.data, !data.isEmpty else { throw HostError(message: "Session transfer ended early") }
            pieces.append(data)
            offset += data.utf16.count
        }
        return try JSONDecoder().decode(SessionSync.self, from: Data(pieces.joined().utf8))
    }

    /// Only the blocks changed since `known`; a full snapshot when it no longer applies.
    func sync(_ sessionId: String, known: HostSession?) async throws -> HostSession {
        do {
            return try await readSync(sessionId, revision: known?.revision).apply(to: known)
        } catch is SessionSync.BaseMismatch where known != nil {
            return try await readSync(sessionId, revision: nil).apply(to: nil)
        }
    }

    @discardableResult
    func command(_ input: [String: Any]) async throws -> CommandReceipt {
        var params = input
        params["commandId"] = UUID().uuidString.lowercased()
        return try await rpc("commands.dispatch", params, as: CommandReceipt.self)
    }

    // MARK: Attachments

    private struct Offset: Decodable { let offset: Int }
    private struct ImageChunk: Decodable { let data: String; let offset: Int }

    /// An image sent in a session's messages, read in the chunks the host serves.
    func image(sessionId: String, attachment: Attachment) async throws -> Data {
        var bytes = Data()
        var offset = 0
        while offset < attachment.size {
            let chunk = try await rpc("attachments.read", ["sessionId": sessionId, "id": attachment.id, "offset": offset], as: ImageChunk.self)
            guard chunk.offset > offset, let piece = Data(base64Encoded: chunk.data) else {
                throw HostError(message: "Could not read \(attachment.name)")
            }
            bytes.append(piece)
            offset = chunk.offset
        }
        return bytes
    }

    /// Uploads to the host's attachment store in chunks, as the desktop does.
    func upload(data: Data, name: String, mimeType: String) async throws -> Attachment {
        guard data.count <= 20 * 1024 * 1024 else { throw HostError(message: "\(name) is too large (20 MB maximum)") }
        let id = UUID().uuidString.lowercased()
        let encoded = data.base64EncodedString()
        // Multiple of 4, so each piece is valid base64 on its own.
        let chunkChars = 4 * ((512 * 1024) / 3)
        var offset = 0
        if encoded.isEmpty {
            _ = try await rpc("attachments.upload", ["id": id, "offset": 0, "size": 0, "data": ""], as: Offset.self)
        }
        var index = encoded.startIndex
        while index < encoded.endIndex {
            let end = encoded.index(index, offsetBy: chunkChars, limitedBy: encoded.endIndex) ?? encoded.endIndex
            offset = try await rpc("attachments.upload", [
                "id": id, "offset": offset, "size": data.count, "data": String(encoded[index..<end]),
            ], as: Offset.self).offset
            index = end
        }
        guard offset == data.count else { throw HostError(message: "Could not finish uploading \(name)") }
        let kind = mimeType.hasPrefix("image/") ? "image" : mimeType.hasPrefix("audio/") ? "audio" : "file"
        return Attachment(id: id, name: name, mimeType: mimeType, kind: kind, size: data.count)
    }
}

let supportedProviders = ["codex", "claude", "cursor", "grok", "opencode", "pi", "omp", "fx", "hermes", "antigravity", "devin"]

extension Attachment {
    var json: [String: Any] {
        ["id": id, "name": name, "mimeType": mimeType, "kind": kind, "size": size]
    }
}
