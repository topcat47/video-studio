// Video Studio: a native Mac window around the always-on library server (http://127.0.0.1:4420).
// The server is the LaunchAgent setup.sh installs (its label and the repo folder are baked into Info.plist by
// scripts/build-studio-app.sh as StudioAgent and StudioRoot); this app never runs its own copy.
// Quitting the app leaves the server (and any background runs) going.
// Build: scripts/build-studio-app.sh  →  ~/Applications/Video Studio.app
import AppKit
import WebKit

// VIDEO_STUDIO_URL / VIDEO_STUDIO_LAUNCHCTL exist only for video-library/test/app.test.js, which runs this
// app against a fake server; normal launches always use the real server and launchctl.
// The overrides below exist only in the separate test build (scripts/build-studio-app.sh --test, compiled
// with -D STUDIO_TEST). The real app ignores its environment: it always talks to the real server, reads the
// real token file and has no test channel, so nothing can launch it pointed at another server.
#if STUDIO_TEST
let env = ProcessInfo.processInfo.environment
#else
let env: [String: String] = [:]
#endif
let base = URL(string: env["VIDEO_STUDIO_URL"] ?? "http://127.0.0.1:4420")!
let launchctl = env["VIDEO_STUDIO_LAUNCHCTL"] ?? "/bin/launchctl"
let testMode = env["VIDEO_STUDIO_URL"] != nil
let agentLabel = (Bundle.main.object(forInfoDictionaryKey: "StudioAgent") as? String) ?? "local.video-studio"
let studioRoot = (Bundle.main.object(forInfoDictionaryKey: "StudioRoot") as? String) ?? (NSHomeDirectory() + "/video-studio")
let pages: [(title: String, path: String, key: String)] = [("Studio", "/studio", "1"), ("Library", "/", "2"), ("Buffer", "/buffer", "3")]

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var tabs: NSSegmentedControl!
    var poll: Timer?
    var restartTried = false
    var failedURL: URL?
    var testActivity: NSObjectProtocol?
    var opened: [String] = []      // links handed to the browser (reported to tests instead of opened)
    var lastAlert = ""
    var downloadsDone = 0

    func openExternal(_ url: URL) {
        if testMode { opened.append(url.absoluteString) } else { NSWorkspace.shared.open(url) }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        // The owner's Studio token is read here, by the app, and handed only to our own pages; the server no
        // longer puts it in the page (anything on this Mac, including a background run's shell, can fetch it).
        let tokenFile = env["VIDEO_STUDIO_TOKEN_FILE"] ?? (studioRoot + "/video-library/.studio-token")
        if let raw = try? String(contentsOfFile: tokenFile, encoding: .utf8) {
            let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil {
                let origin = "\(base.scheme!)://\(base.host!)" + (base.port.map { ":\($0)" } ?? "")
                let js = "if (location.origin === '\(origin)') window.__studioToken = '\(token)';"
                config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            }
        }
        config.preferences.isElementFullscreenEnabled = true
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false   // closing hides it; the Dock icon brings it back
        window.title = "Video Studio"
        window.contentView = web
        window.setFrameAutosaveName("VideoStudioMain")
        if !window.setFrameUsingName("VideoStudioMain") { window.center() }

        tabs = NSSegmentedControl(labels: pages.map(\.title), trackingMode: .selectOne, target: self, action: #selector(tabChanged))
        tabs.selectedSegment = 0
        let toolbar = NSToolbar(identifier: "main")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified

        buildMenu()
        window.makeKeyAndOrderFront(nil)
        open(pages[0].path)
        poll = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.refreshBadge() }
        refreshBadge()
        if testMode {
            // Tests drive a window that sits behind others: keep macOS App Nap from pausing its timers.
            testActivity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "UI tests")
            // and keep the window on top: WebKit slows timers on pages hidden behind other windows.
            window.level = .floating
            Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.testCommand() }
        }
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationDidBecomeActive(_ note: Notification) { refreshBadge() }

    // MARK: navigation
    func open(_ path: String) { web.load(URLRequest(url: URL(string: path, relativeTo: base)!)) }
    @objc func tabChanged() { open(pages[tabs.selectedSegment].path) }
    @objc func showStudio() { tabs.selectedSegment = 0; tabChanged() }
    @objc func showLibrary() { tabs.selectedSegment = 1; tabChanged() }
    @objc func showBuffer() { tabs.selectedSegment = 2; tabChanged() }
    @objc func reload() { web.reload() }
    @objc func openInBrowser() { if let u = web.url { NSWorkspace.shared.open(u) } }

    func isLocal(_ url: URL?) -> Bool { url?.host == "127.0.0.1" || url?.host == "localhost" }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // Embedded frames (the YouTube player in a finds tab) load in place.
        if action.targetFrame.map({ !$0.isMainFrame }) ?? false { return decisionHandler(.allow) }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" || isLocal(url) { return decisionHandler(.allow) }
        openExternal(url)                     // TikTok / X / YouTube links go to the default browser
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The "isn't answering" page itself (known by its title, so a cancelled error page can't leave a stale flag).
        if webView.title == "Studio unreachable" { return }
        restartTried = false
        if let path = webView.url?.path { tabs.selectedSegment = path.hasPrefix("/studio") ? 0 : path.hasPrefix("/buffer") ? 2 : 1 }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Only a server that can't be reached counts. Cancelled loads (a second click, ⌘R mid-load, a link
        // handed to the browser, a download) are normal and must never restart the server.
        let e = error as NSError
        let down: Set<Int> = [NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotFindHost]
        guard e.domain == NSURLErrorDomain, down.contains(e.code) else { return }
        failedURL = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
        serverDown()
    }

    /// The server didn't answer: ask launchd to start it once (no -k: a running server and its background
    /// runs are never killed), wait up to 15 s for it to answer, then show a retry page.
    func serverDown() {
        if !restartTried {
            restartTried = true
            let p = Process()
            p.executableURL = URL(fileURLWithPath: launchctl)
            p.arguments = ["kickstart", "gui/\(getuid())/\(agentLabel)"]
            try? p.run()
            waitForServer(tries: 30)
            return
        }
        let retry = (failedURL ?? URL(string: pages[tabs.selectedSegment].path, relativeTo: base)!).absoluteString
        web.loadHTMLString("""
        <title>Studio unreachable</title>
        <body style="font:15px -apple-system;display:grid;place-items:center;height:90vh;color:#555">
        <div style="text-align:center"><h2>The Studio server isn't answering</h2>
        <p>It runs as the LaunchAgent <code>\(agentLabel)</code>. Log: ~/Library/Logs/video-studio.log</p>
        <p><a href="\(retry)">Try again</a></p></div></body>
        """, baseURL: base)
    }

    func waitForServer(tries: Int) {
        var req = URLRequest(url: URL(string: "/api/studio/state", relativeTo: base)!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (resp as? HTTPURLResponse)?.statusCode == 200 {
                    if let u = self.failedURL { self.web.load(URLRequest(url: u)) } else { self.tabChanged() }
                } else if tries > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForServer(tries: tries - 1) }
                } else {
                    self.serverDown()
                }
            }
        }.resume()
    }

    @objc func restartServer() { restartTried = false; failedURL = web.url; serverDown() }

    // MARK: test channel (only with VIDEO_STUDIO_URL, i.e. under test/app.test.js against a fake server)
    // Reports the window state and runs one command from the fake server: close the window, reopen the app
    // (the same Apple event a Dock click sends), or click the link on the page ("Try again").
    func testCommand() {
        var c = URLComponents(url: URL(string: "/__test/command", relativeTo: base)!, resolvingAgainstBaseURL: true)!
        let content = window.contentLayoutRect, page = web.frame
        c.queryItems = [URLQueryItem(name: "visible", value: window.isVisible ? "1" : "0"),
                        URLQueryItem(name: "window", value: String(window.windowNumber)),
                        // The page must sit exactly inside the area below the toolbar (nothing hidden under it).
                        URLQueryItem(name: "layout", value: "\(Int(page.minY)),\(Int(page.maxY)),\(Int(content.minY)),\(Int(content.maxY))"),
                        URLQueryItem(name: "badge", value: NSApp.dockTile.badgeLabel ?? ""),
                        URLQueryItem(name: "url", value: web.url?.absoluteString ?? ""),
                        URLQueryItem(name: "opened", value: opened.joined(separator: " ")),
                        URLQueryItem(name: "alert", value: lastAlert),
                        URLQueryItem(name: "sheet", value: (window.attachedSheet?.contentView?.subviews.compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: " | ")) ?? ""),
                        URLQueryItem(name: "downloads", value: String(downloadsDone)),
                        URLQueryItem(name: "title", value: web.title ?? "")]
        var req = URLRequest(url: c.url!); req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let cmd = data.flatMap({ String(data: $0, encoding: .utf8) }), !cmd.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                switch cmd {
                case "close": self.window.performClose(nil)
                case "reopen":
                    let target = NSAppleEventDescriptor(processIdentifier: getpid())
                    let ev = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEReopenApplication),
                                                    targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
                    _ = try? ev.sendEvent(options: [.noReply], timeout: 2)
                case "tryagain": self.web.evaluateJavaScript("document.querySelector('a').click()")
                case "reload": self.web.reload()
                case let shot where shot.hasPrefix("snapshot:"):
                    // The whole window (title bar, toolbar and page) drawn by the app itself, for a look.
                    let path = String(shot.dropFirst(9))
                    self.web.takeSnapshot(with: nil) { pageImage, _ in
                        guard let frameView = self.window.contentView?.superview, let pageImage else { return }
                        let size = frameView.bounds.size
                        let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds)!
                        frameView.cacheDisplay(in: frameView.bounds, to: rep)
                        let img = NSImage(size: size); img.addRepresentation(rep)
                        img.lockFocus()
                        let pf = self.web.convert(self.web.bounds, to: frameView)
                        pageImage.draw(in: pf)
                        img.unlockFocus()
                        if let tiff = img.tiffRepresentation, let bmp = NSBitmapImageRep(data: tiff),
                           let png = bmp.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: path)) }
                    }
                case let js where js.hasPrefix("js:"): self.web.evaluateJavaScript(String(js.dropFirst(3)))
                case let rs where rs.hasPrefix("resize:"):
                    let wh = rs.dropFirst(7).split(separator: ",").compactMap { Double($0) }
                    if wh.count == 2 { self.window.setContentSize(NSSize(width: wh[0], height: wh[1])) }
                case let ev where ev.hasPrefix("eval:"):
                    // eval:<id>:<async JS body>  → runs in the page (await allowed), result POSTed to /__test/result?id=<id>
                    let rest = ev.dropFirst(5)
                    guard let colon = rest.firstIndex(of: ":") else { break }
                    let id = String(rest[..<colon]), body = String(rest[rest.index(after: colon)...])
                    self.web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
                        var payload: [String: Any] = [:]
                        switch result {
                        case .success(let v): payload["value"] = v
                        case .failure(let e):
                            let info = (e as NSError).userInfo
                            payload["error"] = "\(info["WKJavaScriptExceptionMessage"] ?? e.localizedDescription) (line \(info["WKJavaScriptExceptionLineNumber"] ?? "?"))"
                        }
                        let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed])) ?? Data("{}".utf8)
                        var c = URLComponents(url: URL(string: "/__test/result", relativeTo: base)!, resolvingAgainstBaseURL: true)!
                        c.queryItems = [URLQueryItem(name: "id", value: id)]
                        var req = URLRequest(url: c.url!); req.httpMethod = "POST"; req.httpBody = data
                        URLSession.shared.dataTask(with: req).resume()
                    }
                default: break
                }
            }
        }.resume()
    }

    // MARK: Dock badge = approvals waiting
    func refreshBadge() {
        URLSession.shared.dataTask(with: URL(string: "/api/studio/state", relativeTo: base)!) { data, _, _ in
            var label: String? = nil
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let gates = obj["gates"] as? [Any], !gates.isEmpty { label = String(gates.count) }
            DispatchQueue.main.async { NSApp.dockTile.badgeLabel = label }
        }.resume()
    }

    // MARK: JS dialogs, new windows, uploads
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // New-window links (gate images, source links) open in the default browser, so the Studio stays put.
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { openExternal(url) }
        return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel(); p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = parameters.allowsDirectories
        p.beginSheetModal(for: window) { completionHandler($0 == .OK ? p.urls : nil) }
    }

    // MARK: downloads → ~/Downloads (never overwrites)
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = env["VIDEO_STUDIO_DOWNLOADS"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename as NSString
        var dest = dir.appendingPathComponent(suggestedFilename), n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            let ext = name.pathExtension.isEmpty ? "" : ".\(name.pathExtension)"
            dest = dir.appendingPathComponent("\(name.deletingPathExtension) \(n)\(ext)"); n += 1
        }
        completionHandler(dest)
    }
    func downloadDidFinish(_ download: WKDownload) { downloadsDone += 1; NSSound(named: "Glass")?.play() }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        lastAlert = "Download failed"
        let a = NSAlert(); a.messageText = "Download failed"; a.informativeText = error.localizedDescription
        a.beginSheetModal(for: window) { _ in }
    }

    // MARK: menu
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About Video Studio", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Restart Studio Server", action: #selector(restartServer), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Video Studio", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Video Studio", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Studio", action: #selector(showStudio), keyEquivalent: "1")
        view.addItem(withTitle: "Library", action: #selector(showLibrary), keyEquivalent: "2")
        view.addItem(withTitle: "Buffer", action: #selector(showBuffer), keyEquivalent: "3")
        view.addItem(.separator())
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }
}

extension AppDelegate: NSToolbarDelegate {
    static let tabsItem = NSToolbarItem.Identifier("tabs")
    func toolbarDefaultItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { [.flexibleSpace, Self.tabsItem, .flexibleSpace] }
    func toolbarAllowedItemIdentifiers(_ t: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(t) }
    func toolbar(_ t: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar: Bool) -> NSToolbarItem? {
        guard id == Self.tabsItem else { return nil }
        let item = NSToolbarItem(itemIdentifier: id); item.view = tabs; return item
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
