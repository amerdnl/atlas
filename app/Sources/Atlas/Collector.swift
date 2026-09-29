import Foundation

/// Runs `node collector/index.js` and restarts it with backoff if it dies.
final class Collector {
    private let collectorDir: URL, sceneDir: URL, port: Int
    private var process: Process?
    private var failures = 0
    private var stopped = false
    private let logURL: URL

    init(collectorDir: URL, sceneDir: URL, port: Int) {
        self.collectorDir = collectorDir; self.sceneDir = sceneDir; self.port = port
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Atlas")
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        logURL = logs.appendingPathComponent("collector.log")
    }

    /// PATH from an interactive login shell, so nvm/homebrew node and herdr are found.
    private static func loginPath() -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-ilc", "echo __PATH__$PATH"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        do { try p.run() } catch { return fallback }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        guard let line = text.split(separator: "\n").last(where: { $0.hasPrefix("__PATH__") }) else { return fallback }
        return String(line.dropFirst("__PATH__".count)) + ":" + fallback
    }

    func start() {
        DispatchQueue.global().async {
            let path = Collector.loginPath()
            DispatchQueue.main.async { self.launch(path: path) }
        }
    }

    private func launch(path: String) {
        guard !stopped else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", collectorDir.appendingPathComponent("index.js").path, "--scene", sceneDir.path, "--port", String(port)]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env["ATLAS_PARENT"] = "1"
        p.environment = env
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let log = try? FileHandle(forWritingTo: logURL) { log.seekToEndOfFile(); p.standardOutput = log; p.standardError = log }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.stopped else { return }
                if proc.terminationStatus == 3 { return } // port taken: another collector is serving; use it
                self.failures += 1
                let delay = min(30.0, pow(2.0, Double(self.failures)))
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.launch(path: path) }
            }
        }
        do { try p.run(); process = p } catch { NSLog("atlas: failed to start collector: \(error)") }
    }

    func stop() {
        stopped = true
        process?.terminate()
    }
}
