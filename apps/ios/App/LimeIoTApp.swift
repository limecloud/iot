import SwiftUI

@main struct LimeIoTApp: App {
    @StateObject private var home = HomeStore()
    @StateObject private var cloud = CloudStore()
    @AppStorage("connection.mode") private var connection = "nas"
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(home).environmentObject(cloud).tint(Palette.grass9)
                .task(id: connection + (scenePhase == .active ? ":active" : ":paused")) {
                    guard scenePhase == .active else { home.media?.pause(); return }
                    if connection == "cloud" { home.media?.pause(); await cloud.runForeground(); return }
                    if !home.connected && !home.endpoint.isEmpty { await home.connect(token: nil, restore: true) }
                    while !Task.isCancelled {
                        await home.refresh()
                        do { try await Task.sleep(for: .seconds(5)) } catch { break }
                    }
                }
        }
    }
}
