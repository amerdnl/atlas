import AppKit

if CommandLine.arguments.contains("--self-test") {
    exit(SliceLayout.selfTest() ? 0 : 1)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
