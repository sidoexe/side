import SwiftUI
import UserNotifications

@main
struct SideMobileApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(delegate.model)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                // `side://pair?host=…&token=…`, from `side-host pair --url`.
                .onOpenURL { url in
                    guard let connection = Connection.parse(address: url.absoluteString, token: "") else { return }
                    Task { @MainActor in
                        do {
                            try await delegate.model.connect(connection)
                        } catch {
                            delegate.model.report(error)
                        }
                    }
                }
                .onChange(of: phase) { _, phase in
                    if phase == .active { Task { await delegate.model.refresh() } }
                }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor let model = AppModel()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        #if DEBUG
        // Scripted simulator runs (see `AppModel.init`) skip the prompt.
        if ProcessInfo.processInfo.environment["SIDE_PAIR_LINK"] != nil { return true }
        #endif
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        Task { @MainActor in model.didRegister(apnsToken: token) }
    }

    /// Shown even with the app open, unless it is the session on screen.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let sessionId = notification.request.content.userInfo["sessionId"] as? String
        let onScreen = await MainActor.run { model.path.last?.sessionId }
        return sessionId != nil && sessionId == onScreen ? [] : [.banner, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let projectId = info["projectId"] as? String, let sessionId = info["sessionId"] as? String else { return }
        await MainActor.run { model.open(projectId: projectId, sessionId: sessionId) }
    }
}
