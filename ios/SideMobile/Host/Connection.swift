import Foundation
import Security

/// A host this phone is paired with: its address and device credential.
/// The phone keeps one per machine, in the Keychain.
struct Connection: Codable, Equatable, Identifiable {
    /// Absent on the single connection older builds saved.
    var id: String
    var endpoint: URL
    var token: String
    /// The name it is shown under, when the user gave one: two Macs often
    /// share a host name.
    var name: String?

    init(id: String = UUID().uuidString.lowercased(), endpoint: URL, token: String, name: String? = nil) {
        self.id = id
        self.endpoint = endpoint
        self.token = token
        self.name = name
    }

    private enum Keys: String, CodingKey { case id, endpoint, token, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        endpoint = try c.decode(URL.self, forKey: .endpoint)
        token = try c.decode(String.self, forKey: .token)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString.lowercased()
        name = try c.decodeIfPresent(String.self, forKey: .name)
    }

    /// Every paired machine, under one item.
    private static let service = "dev.sidoexe.side.mobile.connections"
    /// The single connection of builds before several machines.
    private static let legacyService = "dev.sidoexe.side.mobile.connection"

    private static func read(_ service: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func delete(_ service: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }

    static func loadAll() -> [Connection] {
        if let data = read(service), let all = try? JSONDecoder().decode([Connection].self, from: data) { return all }
        // The pairing of an older build carries over as the first machine.
        if let data = read(legacyService), let one = try? JSONDecoder().decode(Connection.self, from: data) {
            saveAll([one])
            delete(legacyService)
            return [one]
        }
        return []
    }

    static func saveAll(_ connections: [Connection]) {
        delete(service)
        guard !connections.isEmpty else { return }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: (try? JSONEncoder().encode(connections)) ?? Data(),
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    /// Reads what the user typed or scanned: a pairing link
    /// (`side://pair?host=…&token=…`), or an address and a credential.
    static func parse(address: String, token: String) -> Connection? {
        let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URLComponents(string: address), url.scheme == "side" {
            let items = url.queryItems ?? []
            guard let host = items.first(where: { $0.name == "host" })?.value,
                  let token = items.first(where: { $0.name == "token" })?.value else { return nil }
            return parse(address: host, token: token)
        }
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return nil }
        var text = address.hasPrefix("http://") || address.hasPrefix("https://") ? address : "https://\(address)"
        // The web app's address works too: the RPC lives at the root.
        for suffix in ["/web/", "/web", "/"] where text.hasSuffix(suffix) { text.removeLast(suffix.count) }
        guard let endpoint = URL(string: text), endpoint.host() != nil else { return nil }
        return Connection(endpoint: endpoint, token: token)
    }
}
