import SwiftUI

/// Pairing: paste the host's link, or type its address and a credential from
/// `side-host pair --name <device>`.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("lastAddress") private var address = ""
    @State private var token = ""
    @State private var connecting = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    PasteButton(payloadType: String.self) { strings in
                        guard let link = strings.first else { return }
                        Task { await connect(address: link, token: "") }
                    }
                } footer: {
                    Text("On the host, run `side-host pair --name iPhone --url <its address>` and copy the link, or open it on this phone.")
                }
                Section {
                    TextField("https://host.example.ts.net", text: $address)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Device credential", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Or enter it")
                } footer: {
                    if let failure { Text(failure).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await connect(address: address, token: token) }
                    } label: {
                        HStack {
                            Text("Connect")
                            if connecting { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(connecting || address.isEmpty || token.isEmpty)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Connect to a host")
        }
    }

    private func connect(address: String, token: String) async {
        failure = nil
        guard let connection = Connection.parse(address: address, token: token) else {
            failure = "That is not a host address and a 43-character credential."
            return
        }
        connecting = true
        defer { connecting = false }
        do {
            try await model.connect(connection)
            self.address = connection.endpoint.absoluteString
        } catch {
            failure = error.localizedDescription
        }
    }
}
