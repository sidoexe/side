import SafariServices
import SwiftUI
import WebKit

struct HostWebApp: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let url: String
    let folder: String?
}

struct HostWebApps: Decodable {
    let apps: [HostWebApp]
}

private struct HostWebAppSession: Decodable {
    let cookies: [String]
}

/// A page the desktop keeps as a web app, signed in with the login it saved
/// on the host, so a review page opens here as it does there.
struct WebAppView: View {
    @Environment(AppModel.self) private var model
    let app: HostWebApp
    @State private var page = WebPage()
    @State private var ready = false

    var body: some View {
        WebPageView(page: page)
            .ignoresSafeArea(edges: .bottom)
            .overlay { if !ready { ProgressView() } }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(app.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { page.view.goBack() } label: { Image(systemName: "chevron.backward") }
                        .disabled(!page.canGoBack)
                    Button { page.view.reload() } label: { Image(systemName: "arrow.clockwise") }
                    if let url = URL(string: app.url) {
                        Link(destination: page.view.url ?? url) { Image(systemName: "safari") }
                    }
                }
            }
            .task(id: app.id) { await open() }
    }

    /// Hands the saved login to the web view, then loads the page.
    private func open() async {
        guard let url = URL(string: app.url) else { return }
        // The login is kept on the host that lists the app.
        let machine = model.machines.first { $0.webApps?.contains(app) == true } ?? model.machines.first
        if let session = try? await machine?.client.rpc("webApps.session", ["id": app.id], as: HostWebAppSession?.self) {
            let store = page.view.configuration.websiteDataStore.httpCookieStore
            for header in session.cookies {
                for cookie in HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url) {
                    await store.setCookie(cookie)
                }
            }
        }
        page.view.load(URLRequest(url: url))
        ready = true
    }
}

/// The web view and whether it can go back, for the toolbar.
@Observable
final class WebPage: NSObject {
    let view: WKWebView
    var canGoBack = false
    private var watch: NSKeyValueObservation?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = true
        view.isOpaque = false
        view.backgroundColor = .clear
        super.init()
        watch = view.observe(\.canGoBack) { [weak self] view, _ in
            Task { @MainActor in self?.canGoBack = view.canGoBack }
        }
    }
}

private struct WebPageView: UIViewRepresentable {
    let page: WebPage
    func makeUIView(context: Context) -> WKWebView { page.view }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
