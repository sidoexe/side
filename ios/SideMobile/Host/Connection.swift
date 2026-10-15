import Foundation
import Security

/// The host this phone is paired with: its address and device credential,
/// kept in the Keychain.
struct Connection: Codable, Equatable {
    var endpoint: URL
    var token: String

    private static let service = "dev.sidoexe.side.mobile.connection"

    static func load() -> Connection? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Connection.self, from: data)
    }

    func save() {
        Connection.clear()
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Connection.service,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: (try? JSONEncoder().encode(self)) ?? Data(),
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
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
