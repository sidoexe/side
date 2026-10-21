import SwiftUI

/// The first screen, before any machine is paired.
struct ConnectView: View {
    var body: some View {
        NavigationStack {
            ConnectForm()
                .navigationTitle("Connect to a host")
        }
    }
}

/// Pairing a machine: paste its host's link, or type its address and a
/// credential from `side-host pair --name <device>`. Each machine paired is
/// added beside the others.
struct ConnectForm: View {
    @Environment(AppModel.self) private var model
    @AppStorage("lastAddress") private var address = ""
    @State private var token = ""
    @State private var connecting = false
    @State private var failure: String?
    /// After a machine is added from the Machines sheet.
    var onDone: (() -> Void)?

    var body: some View {
        Form {
            Section {
                PasteButton(payloadType: String.self) { strings in
                    guard let link = strings.first else { return }
                    Task { await connect(address: link, token: "") }
                }
            } footer: {
                Text("On the machine, run `side-host pair --name iPhone --url <its address>` and copy the link, or open it on this phone.")
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
            self.token = ""
            onDone?()
        } catch {
            failure = error.localizedDescription
        }
    }
}
