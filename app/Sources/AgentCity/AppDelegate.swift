import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let port = 47823
    private var windows: [WallpaperWindow] = []
    private var collector: Collector!
    private var statusItem: NSStatusItem!
    private var userPaused = false, systemPaused = false, demo = false
    private var rebuildWork: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = ProcessInfo.processInfo.environment["AGENT_CITY_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL!
        collector = Collector(collectorDir: root.appendingPathComponent("collector"),
                              sceneDir: root.appendingPathComponent("scene"), port: port)
        collector.start()
        buildMenu()
        rebuildWindows()
        observeSystem()
    }

    func applicationWillTerminate(_ notification: Notification) { collector.stop() }

    // MARK: windows

    private func rebuildWindows() {
        windows.forEach { $0.close() }
        windows = []
        let screens = NSScreen.screens
        let layout = SliceLayout.make(frames: screens.map(\.frame))
        for (i, screen) in screens.enumerated() {
            let s = layout.slices[i]
            let showcase = i == layout.showcaseIndex
            var c = URLComponents(string: "http://127.0.0.1:\(port)/")!
            c.queryItems = [
                ("fullW", layout.fullW), ("fullH", layout.fullH), ("x", s.x), ("y", s.y), ("w", s.w), ("h", s.h),
            ].map { URLQueryItem(name: $0.0, value: String(Int($0.1))) } + [
                URLQueryItem(name: "fps", value: showcase ? "60" : "30"),
                URLQueryItem(name: "overlay", value: showcase ? "1" : "0"),
                URLQueryItem(name: "demo", value: demo ? "1" : "0"),
            ]
            let w = WallpaperWindow(screen: screen)
            w.load(c.url!)
            w.orderFrontRegardless()
            windows.append(w)
        }
        applyPaused()
    }

    private func scheduleRebuild() {
        rebuildWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rebuildWindows() }
        rebuildWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    private func applyPaused() { windows.forEach { $0.setPaused(userPaused || systemPaused) } }

    // MARK: system events

    private func observeSystem() {
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.scheduleRebuild() }
        let ws = NSWorkspace.shared.notificationCenter
        for (name, paused) in [(NSWorkspace.screensDidSleepNotification, true), (NSWorkspace.willSleepNotification, true),
                               (NSWorkspace.screensDidWakeNotification, false), (NSWorkspace.didWakeNotification, false)] {
            ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.systemPaused = paused; self?.applyPaused() }
        }
        let dnc = DistributedNotificationCenter.default()
        for (name, paused) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            dnc.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in self?.systemPaused = paused; self?.applyPaused() }
        }
    }

    // MARK: menu

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "building.2", accessibilityDescription: "Agent City")
        statusItem.menu = makeMenu()
    }

    private func makeMenu() -> NSMenu {
        let menu = NSMenu()
        func item(_ title: String, _ action: Selector, _ on: Bool? = nil) {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
            i.target = self
            if let on { i.state = on ? .on : .off }
            menu.addItem(i)
        }
        item(userPaused ? "Resume" : "Pause", #selector(togglePause))
        item("Demo mode", #selector(toggleDemo), demo)
        item("Reload scene", #selector(reload))
        item("Launch at login", #selector(toggleLogin), SMAppService.mainApp.status == .enabled)
        menu.addItem(.separator())
        item("Quit Agent City", #selector(quit))
        return menu
    }

    private func refreshMenu() { statusItem.menu = makeMenu() }

    @objc private func togglePause() { userPaused.toggle(); applyPaused(); refreshMenu() }
    @objc private func toggleDemo() { demo.toggle(); rebuildWindows(); refreshMenu() }
    @objc private func reload() { windows.forEach { $0.webView.reload() } }
    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch { NSLog("agent-city: login item: \(error)") }
        refreshMenu()
    }
    @objc private func quit() { NSApp.terminate(nil) }
}
