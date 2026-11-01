import SwiftUI

@main struct LimeIoTApp: App {
    @StateObject private var home = HomeStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(home).tint(Palette.grass9)
                .task { if !home.endpoint.isEmpty { await home.connect(token: nil, restore: true) } }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        await home.refresh()
                        try? await Task.sleep(for: .seconds(5))
                    }
                }
        }
    }
}
