import UIKit
import WebKit

/// Wraps the same index.html the desktop and Android apps use. Fetches the
/// latest copy from GitHub on every launch (mirroring main.js's
/// resolveAppHtmlPath / MainActivity.kt's resolveHtmlToLoad), falling back to
/// the last successfully fetched copy, then to the bundled resource if
/// neither is available. WKUIDelegate gives real, built-in support for
/// alert()/confirm()/prompt() dialogs, same as Android's WebChromeClient —
/// none of the Electron-side workarounds this project needed apply here
/// either.
///
/// No in-app update checker: unlike the desktop/Android builds, a sideloaded
/// iOS app has no API to hand itself an update to install — that has to
/// happen through Sideloadly/AltStore again from the PC side (or TestFlight,
/// with a paid developer account). Content still refreshes live; the app
/// binary itself does not self-update.
class ViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {

    private var webView: WKWebView!
    private var refreshControl: UIRefreshControl!

    private static let repoContentsBase =
        "https://api.github.com/repos/antoniortizajoa160887-cloud/tracker-app/contents"
    private static let remoteHtmlURL = URL(string: "\(repoContentsBase)/index.html?ref=main")!
    private static let fetchTimeout: TimeInterval = 8

    override func viewDidLoad() {
        super.viewDidLoad()

        let webView = WKWebView(frame: .zero)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        self.webView = webView

        refreshControl = UIRefreshControl()
        refreshControl.addTarget(self, action: #selector(handlePullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl
        webView.scrollView.bounces = true

        loadContent()
    }

    @objc private func handlePullToRefresh() {
        loadContent()
    }

    // MARK: - Content loading

    private struct FetchResult {
        let fileURL: URL
        let source: String // "live" | "cached" | "bundled"
        let error: String?
    }

    private func cacheFileURL() -> URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("index.html")
    }

    private func loadContent() {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.resolveHtmlToLoad()
            DispatchQueue.main.async {
                self.webView.loadFileURL(result.fileURL, allowingReadAccessTo: result.fileURL.deletingLastPathComponent())
                if result.source != "live" {
                    self.pendingBanner = self.contentStatusMessage(source: result.source, error: result.error)
                }
                self.refreshControl.endRefreshing()
            }
        }
    }

    // Shown once the page finishes loading (see webView(_:didFinish:) below) —
    // injecting immediately after loadFileURL races the page's own scripts.
    private var pendingBanner: String?

    private func resolveHtmlToLoad() -> FetchResult {
        var request = URLRequest(url: Self.remoteHtmlURL, timeoutInterval: Self.fetchTimeout)
        request.setValue("application/vnd.github.raw", forHTTPHeaderField: "Accept")
        request.setValue("unified-logistics-hr-dashboard-ios", forHTTPHeaderField: "User-Agent")

        let semaphore = DispatchSemaphore(value: 0)
        var fetchedHtml: String?
        var fetchError: String?

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error = error {
                fetchError = error.localizedDescription
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data else {
                fetchError = "Unexpected response"
                return
            }
            guard let html = String(data: data, encoding: .utf8), html.count >= 1000 else {
                fetchError = "Fetched content looks too small, ignoring"
                return
            }
            fetchedHtml = html
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + Self.fetchTimeout + 2)

        if let html = fetchedHtml {
            let target = cacheFileURL()
            try? html.write(to: target, atomically: true, encoding: .utf8)
            return FetchResult(fileURL: target, source: "live", error: nil)
        }
        return fallbackAfterFailure(error: fetchError ?? "Unknown error")
    }

    private func fallbackAfterFailure(error: String) -> FetchResult {
        let cached = cacheFileURL()
        if FileManager.default.fileExists(atPath: cached.path) {
            return FetchResult(fileURL: cached, source: "cached", error: error)
        }
        if let bundled = Bundle.main.url(forResource: "index", withExtension: "html") {
            return FetchResult(fileURL: bundled, source: "bundled", error: error)
        }
        // Should never happen (index.html ships as a bundled resource), but
        // avoids a crash if the resource is ever missing from the bundle.
        let placeholder = FileManager.default.temporaryDirectory.appendingPathComponent("placeholder.html")
        try? "<html><body style=\"background:#08101A;color:#fff;font-family:sans-serif;padding:20px\">Could not load the dashboard. Check your connection and pull down to retry.</body></html>"
            .write(to: placeholder, atomically: true, encoding: .utf8)
        return FetchResult(fileURL: placeholder, source: "bundled", error: error)
    }

    private func contentStatusMessage(source: String, error: String?) -> String {
        let label = source == "cached"
            ? "Showing last downloaded version — could not reach GitHub just now"
            : "Showing the version bundled with the app — could not reach GitHub"
        return error.map { "\(label) (\($0))" } ?? label
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let message = pendingBanner else { return }
        pendingBanner = nil
        let escaped = message
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: " ")
        let js = """
        (function(){
          var b = document.createElement('div');
          b.textContent = '\(escaped)';
          b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b45309;color:#fff;font:12px/1.4 sans-serif;padding:6px 12px;text-align:center;';
          document.body.appendChild(b);
        })();
        """
        webView.evaluateJavaScript(js)
    }

    // MARK: - JS dialogs (WKUIDelegate) — real, native support, same as Android

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: deriveDialogTitle(message), message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: deriveDialogTitle(message), message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: deriveDialogTitle(prompt), message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text ?? "")
        })
        present(alert, animated: true)
    }

    private func deriveDialogTitle(_ message: String) -> String {
        let patterns: [(String, String)] = [
            ("delete all routes", "Delete All Routes"),
            ("delete all claims", "Delete All Claims"),
            ("delete all charges", "Delete All Charges"),
            ("delete all users", "Delete All Users"),
            ("reset all data", "Reset All Data"),
            ("reset system", "System Reset"),
            ("new password", "Reset Password"),
        ]
        let lower = message.lowercased()
        for (needle, title) in patterns where lower.contains(needle) {
            return title
        }
        let firstLine = message.split(separator: "\n").first.map(String.init) ?? message
        let trimmed = firstLine.trimmingCharacters(in: CharacterSet(charactersIn: ":? ")).trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty && trimmed.count <= 60 {
            return trimmed
        }
        return "Unified Logistics HR Claims Dashboard"
    }
}
