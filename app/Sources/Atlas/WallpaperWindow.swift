import AppKit
import WebKit

/// A borderless, click-through window at desktop level (below the icons) hosting one scene slice.
final class WallpaperWindow: NSWindow, WKNavigationDelegate {
    let webView: WKWebView
    private var url: URL?

    init(screen: NSScreen) {
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true
        webView = WKWebView(frame: NSRect(origin: .zero, size: screen.frame.size), configuration: config)
        super.init(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        setFrame(screen.frame, display: false)
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        ignoresMouseEvents = true
        isOpaque = true
        hasShadow = false
        backgroundColor = .black
        isReleasedWhenClosed = false
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        contentView = webView
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func load(_ url: URL) {
        self.url = url
        webView.load(URLRequest(url: url))
    }

    /// The collector may still be starting; keep retrying until the page loads.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, let url = self.url else { return }
            self.webView.load(URLRequest(url: url))
        }
    }

    func setPaused(_ paused: Bool) {
        webView.evaluateJavaScript("window.atlas && window.atlas.setPaused(\(paused))")
    }
}
