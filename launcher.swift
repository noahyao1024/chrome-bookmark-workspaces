import Foundation
import SQLite3
import Darwin

typealias Row = [String: Any]
@_silgen_name("chrome_timing_exchange")
private func chromeTimingExchange(_ path: UnsafePointer<CChar>, _ message: UnsafePointer<CChar>, _ reply: UnsafeMutablePointer<CChar>, _ capacity: Int32, _ timeout: Int32) -> Int32
@_silgen_name("chrome_timing_exchange_tracked")
private func chromeBridgeExchange(_ path: UnsafePointer<CChar>, _ message: UnsafePointer<CChar>, _ reply: UnsafeMutablePointer<CChar>, _ capacity: Int32, _ timeout: Int32, _ dispatched: UnsafeMutablePointer<Int32>) -> Int32
let diagnosticStartedNs = DispatchTime.now().uptimeNanoseconds
var timingContext: Row = [:]
var timingQuery = ""
var timingOverheadNs: UInt64 = 0
func timingEvent(_ type: String, data: Row = [:], context: Row? = nil) -> Row {
    if ProcessInfo.processInfo.environment["chrome_alias_diagnostics_disabled"] == "1" { return [:] }
    let started = DispatchTime.now().uptimeNanoseconds
    defer { timingOverheadNs += DispatchTime.now().uptimeNanoseconds - started }
    let message: Row = ["type": type, "trace": diagnosticTrace, "atNs": String(started),
                        "data": data, "context": context ?? timingContext]
    guard let bytes = try? JSONSerialization.data(withJSONObject: message),
          let string = String(data: bytes, encoding: .utf8) else { return [:] }
    var response = [CChar](repeating: 0, count: 4096)
    let count = (NSHomeDirectory() + "/Library/Caches/BookmarkWorkspaces/timing.sock").withCString { path in
        (string + "\n").withCString { chromeTimingExchange(path, $0, &response, Int32(response.count), 12) }
    }
    guard count > 0 else { return [:] }
    return (try? JSONSerialization.jsonObject(with: Data(response.prefix(Int(count)).map { UInt8(bitPattern: $0) }))) as? Row ?? [:]
}
let historyCandidateLimit = 50
let historyResultLimit = 10
var searchPhases: [String: Double] = [:]
let inheritedActionTrace = ProcessInfo.processInfo.environment["chrome_search_trace"] ?? ""
let diagnosticTrace = CommandLine.arguments.dropFirst().first == "--activate" &&
    inheritedActionTrace.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil ? inheritedActionTrace : UUID().uuidString
let diagnosticStarted = ProcessInfo.processInfo.systemUptime

func diagnosticLog(_ record: Row, name: String = "search.jsonl") {
    if ProcessInfo.processInfo.environment["chrome_alias_diagnostics_disabled"] == "1" { return }
    do {
        let fm = FileManager.default
        let dir = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/BookmarkWorkspaces")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = dir.appendingPathComponent(name), old = dir.appendingPathComponent(name + ".1")
        if let attrs = try? fm.attributesOfItem(atPath: file.path), let size = attrs[.size] as? NSNumber, size.intValue > 1_048_576 {
            try? fm.removeItem(at: old);try fm.moveItem(at: file, to: old)
        }
        if !fm.fileExists(atPath: file.path) { fm.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        data.append(0x0A)
        let fd = Darwin.open(file.path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
        guard fd >= 0 else { return }
        defer { Darwin.close(fd) }
        data.withUnsafeBytes { bytes in _ = Darwin.write(fd, bytes.baseAddress, bytes.count) }
    } catch { /* A diagnostic write must not break search. */ }
}

func configuredProfile() -> String? {
    guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("alias-config.json")),
          let config = (try? JSONSerialization.jsonObject(with: bytes)) as? Row,
          let profile = config["profile"] as? String,
          profile.range(of: "^[A-Za-z0-9 _.-]+$", options: .regularExpression) != nil,
          profile != ".", profile != ".." else { return nil }
    return profile
}

func bridgeRequest(_ endpoint: String, payload: Row? = nil, timeout: Int32 = 60) -> (Int, Row)? {
    let socket = ProcessInfo.processInfo.environment["chrome_alias_native_socket"] ?? (NSHomeDirectory() + "/Library/Caches/BookmarkWorkspaces/native.sock")
    guard !socket.isEmpty, FileManager.default.fileExists(atPath: socket), let profile = configuredProfile() else { return nil }
    let body = payload.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
    var wire = "\(payload == nil ? "GET" : "POST") \(endpoint) HTTP/1.0\r\nHost: localhost\r\nX-Chrome-Profile: \(profile)\r\nX-Chrome-Trace: \(diagnosticTrace)\r\n"
    if let operation = timingContext["op"] as? String { wire += "X-Chrome-Timing-Operation: \(operation)\r\n" }
    wire += "X-Chrome-Expires: \(Int(Date().timeIntervalSince1970 * 1000) + 800)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n"
    wire += String(data: body, encoding: .utf8) ?? ""
    var reply = [CChar](repeating: 0, count: endpoint == "/index" ? 4_259_840 : 65_536)
    var dispatched: Int32 = 0
    let count = socket.withCString { path in wire.withCString { chromeBridgeExchange(path, $0, &reply, Int32(reply.count), timeout, &dispatched) } }
    if count <= 0 && dispatched == 0 { return (503, ["kind": "miss", "reason": "connect_unavailable"]) }
    guard count > 0 else { return nil }
    let data = reply.withUnsafeBytes { Data($0.prefix(Int(count))) }
    guard let split = data.range(of: Data("\r\n\r\n".utf8)),
          let header = String(data: data[..<split.lowerBound], encoding: .utf8),
          let code = header.split(separator: " ").dropFirst().first.flatMap({ Int($0) }),
          let decoded = (try? JSONSerialization.jsonObject(with: data[split.upperBound...])) as? Row else { return nil }
    return (code, decoded)
}

func executeAdapter(_ mode: String, _ argument: String) throws -> (Int32, Row) {
    let process = Process(), pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("chrome-alias.js")
    process.arguments = [mode, argument]
    process.environment = ProcessInfo.processInfo.environment.merging(["chrome_action_trace": diagnosticTrace]) { _, new in new }
    process.standardOutput = pipe
    try process.run()
    let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, (try? JSONSerialization.jsonObject(with: bytes)) as? Row ?? [:])
}

func activate(_ argument: String) throws {
    guard let payload = (try? JSONSerialization.jsonObject(with: Data(argument.utf8))) as? Row,
          payload["version"] as? Int == 1, let url = payload["url"] as? String,
          url.range(of: "^(https?|file|chrome|about):", options: [.regularExpression, .caseInsensitive]) != nil else {
        throw NSError(domain: "ChromeAction", code: 1)
    }
    let start = DispatchTime.now().uptimeNanoseconds
    let timeMs = Int(Date().timeIntervalSince1970 * 1000)
    diagnosticLog(["phase": "begin", "timeMs": timeMs, "trace": diagnosticTrace], name: "action-total.jsonl")
    timingContext = timingEvent("action_begin", data: payload)
    let bridgeStart = DispatchTime.now().uptimeNanoseconds
    let response = bridgeRequest("/activate", payload: payload, timeout: 1100)
    let bridgeMs = Double(DispatchTime.now().uptimeNanoseconds - bridgeStart) / 1_000_000
    var result: Row = [:], route = "bridge-error", reason = "unconfirmed", code: Int32 = 0
    if let (status, value) = response, status == 200, ["focused", "opened"].contains(value["kind"] as? String ?? "") {
        result = value; route = value["kind"] as? String == "opened" ? "native-open" : "native-bridge"; reason = "acknowledged"
    } else if response.map({ [404, 409, 503].contains($0.0) }) == true ||
                (response == nil && !FileManager.default.fileExists(atPath: ProcessInfo.processInfo.environment["chrome_alias_native_socket"] ?? NSHomeDirectory() + "/Library/Caches/BookmarkWorkspaces/native.sock")) {
        route = "jxa"; reason = response?.1["reason"] as? String ?? "socket_unavailable"
        (code, result) = try executeAdapter("activate", argument)
    } else {
        code = 1
        reason = response?.1["reason"] as? String ?? "unconfirmed"
        _ = try? executeAdapter("notify", reason == "ambiguous_entry" ? "该工作区有多个页面，请重新搜索并选择已打开的标签" : "操作未能确认，请重新搜索后重试")
    }
    // Keep the existing action IPC shape so the collector can correlate Return.
    let endStarted = DispatchTime.now().uptimeNanoseconds
    let message: Row = ["type": "action_end", "trace": diagnosticTrace, "atNs": String(endStarted),
                       "data": result, "context": timingContext, "status": ["route": route, "exitCode": Int(code)]]
    if ProcessInfo.processInfo.environment["chrome_alias_diagnostics_disabled"] != "1",
       let data = try? JSONSerialization.data(withJSONObject: message), let wire = String(data: data, encoding: .utf8) {
        var reply = [CChar](repeating: 0, count: 4096)
        _ = (NSHomeDirectory() + "/Library/Caches/BookmarkWorkspaces/timing.sock").withCString { path in
            (wire + "\n").withCString { chromeTimingExchange(path, $0, &reply, Int32(reply.count), 12) }
        }
    }
    timingOverheadNs += DispatchTime.now().uptimeNanoseconds - endStarted
    print(try encoded(result))
    diagnosticLog(["phase": "complete", "timeMs": timeMs, "trace": diagnosticTrace,
                   "durationMs": Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000,
                   "route": route, "reason": reason, "resultType": ProcessInfo.processInfo.environment["chrome_result_type"] ?? "unknown",
                   "exitCode": Int(code), "bridgeMs": bridgeMs, "bridgeHttp": String(response?.0 ?? 0),
                   "timingInstrumentationMs": Double(timingOverheadNs) / 1_000_000], name: "action-total.jsonl")
    if code != 0 { exit(code) }
}

func emitSearch(_ output: Row, metrics: Row) throws {
    var output = output, variables = output["variables"] as? Row ?? [:]
    variables["chrome_search_trace"] = diagnosticTrace
    variables["chrome_search_completed_ms"] = String(Int(Date().timeIntervalSince1970 * 1000))
    if let session = timingContext["session"] { variables["chrome_timing_session"] = session }
    output["variables"] = variables
    let encodedOutput = try encoded(output)
    let expectedRows = Array((output["items"] as? [Row] ?? []).prefix(2)).map { row -> [String: String] in
        ["title": row["title"] as? String ?? "", "subtitle": row["subtitle"] as? String ?? ""]
    }
    _ = timingEvent("search_prepared", data: ["rows": expectedRows, "placeholder": metrics["prime"] as? Bool == true])
    var record = metrics
    record["phase"] = "complete";record["trace"] = diagnosticTrace
    record["timeMs"] = Int(Date().timeIntervalSince1970 * 1000)
    record["durationMs"] = (ProcessInfo.processInfo.systemUptime - diagnosticStarted) * 1000
    record["phases"] = searchPhases
    record["rows"] = (output["items"] as? [Row])?.count ?? 0
    record["historyRows"] = (output["items"] as? [Row])?.filter { $0["_history"] as? Bool == true }.count ?? 0
    record["responseBytes"] = encodedOutput.utf8.count
    let writeStarted = DispatchTime.now().uptimeNanoseconds
    try FileHandle.standardOutput.write(contentsOf: Data((encodedOutput + "\n").utf8))
    let written = DispatchTime.now().uptimeNanoseconds
    _ = timingEvent("search_written", data: ["placeholder": metrics["prime"] as? Bool == true])
    record["stdoutWriteMs"] = Double(written - writeStarted) / 1_000_000
    record["processToOutputWrittenMs"] = Double(written - diagnosticStartedNs) / 1_000_000
    record["timingInstrumentationMs"] = Double(timingOverheadNs) / 1_000_000
    record["e2eState"] = timingContext["op"] == nil ? "collector_unavailable" : "see_e2e_log"
    record["timingOperation"] = timingContext["op"] ?? NSNull()
    if ProcessInfo.processInfo.environment["chrome_alias_benchmark"] == "1",
       let bytes = try? JSONSerialization.data(withJSONObject: record) {
        FileHandle.standardError.write(bytes + Data("\n".utf8))
    }
    diagnosticLog(record)
}

func historyError() -> NSError { NSError(domain: "ChromeHistory", code: 1) }

func openHistory(_ path: String, recover: Bool = false) throws -> OpaquePointer {
    var db: OpaquePointer?
    let status = sqlite3_open_v2(path, &db, recover ? SQLITE_OPEN_READWRITE : SQLITE_OPEN_READONLY, nil)
    guard status == SQLITE_OK, let opened = db else {
        if let db { sqlite3_close(db) }
        throw historyError()
    }
    sqlite3_busy_timeout(opened, 100)
    return opened
}

func snapshotHistory(to directory: URL, from suppliedSource: URL? = nil) throws -> URL {
    let fm = FileManager.default
    let source: URL
    if let suppliedSource { source = suppliedSource } else {
        let configData = try Data(contentsOf: URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("alias-config.json"))
        guard let config = try JSONSerialization.jsonObject(with: configData) as? Row,
              let profile = config["profile"] as? String,
              profile.range(of: "^[A-Za-z0-9 _.-]+$", options: .regularExpression) != nil,
              profile != ".", profile != ".." else { throw historyError() }
        source = URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/Google/Chrome/" + profile)
    }
    let names = ["History", "History-wal", "History-journal"]
    func signature() throws -> [String: String] {
        var values: [String: String] = [:]
        for name in names {
            let path = source.appendingPathComponent(name).path
            // Do not treat permission failures on the main DB as an empty history.
            if name != "History" && !fm.fileExists(atPath: path) { continue }
            let attrs = try fm.attributesOfItem(atPath: path)
            let modified = (attrs[.modificationDate] as! Date).timeIntervalSinceReferenceDate
            values[name] = "\(attrs[.size]!)|\(modified)|\(attrs[.systemFileNumber]!)"
        }
        return values
    }
    for _ in 0..<3 {
        try? fm.removeItem(at: directory)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        do {
            let before = try signature()
            for name in names where before[name] != nil {
                let target = directory.appendingPathComponent(name)
                try fm.copyItem(at: source.appendingPathComponent(name), to: target)
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            }
            guard before == (try signature()) else { continue }
            let target = directory.appendingPathComponent("History")
            // Recover any copied rollback journal / WAL only in our private copy.
            let db = try openHistory(target.path, recover: true)
            defer { sqlite3_close(db) }
            guard sqlite3_exec(db, "SELECT url, title, last_visit_time FROM urls LIMIT 1", nil, nil, nil) == SQLITE_OK else { continue }
            return target
        } catch { continue }
    }
    try? fm.removeItem(at: directory)
    throw historyError()
}

func historyRows(_ database: URL, query: String) throws -> [Row] {
    let tokens = normalized(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
    if tokens.isEmpty { return [] }
    let db = try openHistory(database.path)
    defer { sqlite3_close(db) }
    let conditions = tokens.map { _ in "(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')" }.joined(separator: " AND ")
    let sql = "SELECT url, title, last_visit_time FROM urls WHERE hidden=0 AND (url LIKE 'https://%' OR url LIKE 'http://%' OR url LIKE 'file://%') AND " + conditions + " ORDER BY last_visit_time DESC LIMIT \(historyCandidateLimit)"
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw historyError() }
    defer { sqlite3_finalize(statement) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (i, token) in tokens.enumerated() {
        let pattern = "%" + token.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_") + "%"
        for column in [i * 2 + 1, i * 2 + 2] {
            guard sqlite3_bind_text(statement, Int32(column), pattern, -1, transient) == SQLITE_OK else { throw historyError() }
        }
    }
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    var rows: [Row] = []
    while true {
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { break }
        guard status == SQLITE_ROW, let rawURL = sqlite3_column_text(statement, 0) else { throw historyError() }
        let url = String(cString: rawURL)
        let title = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
        let date = Date(timeIntervalSince1970: Double(sqlite3_column_int64(statement, 2)) / 1_000_000 - 11_644_473_600)
        let payload: Row = ["version": 1, "url": url]
        rows.append([
            "title": title.isEmpty ? url : title,
            "subtitle": "历史 · " + formatter.string(from: date) + " · " + url,
            "match": normalized(title + " " + url + " " + (url.removingPercentEncoding ?? url)),
            "arg": try encoded(payload), "valid": true, "_history": true,
            "text": ["copy": url],
            "mods": ["cmd": ["valid": true, "subtitle": "另开一个标签", "arg": try encoded(["version": 1, "url": url, "forceNew": true])],
                     "ctrl": ["valid": true, "subtitle": "复制完整网址", "arg": url]]
        ])
    }
    return rows
}

func mergeHistory(_ base: [Row], _ history: [Row]) -> [Row] {
    var rows = base, positions: [String: Int] = [:]
    for (i, row) in rows.enumerated() {
        if let url = (row["text"] as? Row)?["copy"] as? String {
            // Historical deep-link titles must match the exact page action,
            // rather than the app-entry action sharing its current URL.
            if let previous = positions[url], rows[previous]["_entry"] as? Bool != true { continue }
            positions[url] = i
        }
    }
    for row in history {
        guard let url = (row["text"] as? Row)?["copy"] as? String else { continue }
        if let i = positions[url] {
            // Keep bookmark aliases and live tab IDs, but also match historical titles.
            rows[i]["match"] = (rows[i]["match"] as? String ?? "") + " " + (row["match"] as? String ?? "")
        } else {
            positions[url] = rows.count
            rows.append(row)
        }
    }
    return rows
}

func normalized(_ value: String) -> String {
    value.precomposedStringWithCompatibilityMapping
        .replacingOccurrences(of: "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF]", with: "", options: .regularExpression)
        .lowercased()
}

func validBareHost(_ host: String) -> Bool {
    if host == "localhost" { return true }
    if host.hasPrefix("["), host.hasSuffix("]") {
        var address = in6_addr()
        return String(host.dropFirst().dropLast()).withCString { inet_pton(AF_INET6, $0, &address) } == 1
    }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    if labels.count == 4 && labels.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0.isASCII && $0.isNumber }) }) {
        return labels.allSatisfy { Int($0).map { (0...255).contains($0) } ?? false }
    }
    guard labels.count >= 2, let last = labels.last, last.contains(where: { $0.isLetter }) else { return false }
    return labels.allSatisfy { label in
        !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-" &&
            label.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }
}

func destination(_ input: String) -> String {
    if input.isEmpty { return "chrome://newtab/" }
    let lower = input.lowercased()
    let schemes = ["https://", "http://", "chrome://", "file://", "about:"]
    if schemes.contains(where: { lower.hasPrefix($0) }) { return input }
    // Bare domains, IPs and localhost; ordinary words remain searches.
    if !input.contains(where: { $0.isWhitespace }),
       let parts = URLComponents(string: "https://" + input),
       let host = parts.host, parts.user == nil, parts.password == nil,
       validBareHost(host.lowercased()), parts.port.map({ (1...65535).contains($0) }) ?? true {
        return (["localhost", "127.0.0.1", "[::1]"].contains(host.lowercased()) ? "http://" : "https://") + input
    }
    var search = URLComponents(string: "https://www.google.com/search")!
    search.queryItems = [URLQueryItem(name: "q", value: input)]
    return search.url!.absoluteString.replacingOccurrences(of: "+", with: "%2B")
}

func encoded(_ value: Any) throws -> String {
    String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
}

func addressRow(_ input: String) throws -> Row {
    let url = destination(input)
    var payload: Row = ["version": 1, "url": url]
    if input.isEmpty { payload["forceNew"] = true }
    var newPayload = payload
    newPayload["forceNew"] = true
    let isSearch = !input.isEmpty && url.hasPrefix("https://www.google.com/search?q=") && url != input
    return [
        "title": input.isEmpty ? "新标签 · 地址栏" : input,
        "icon": ["path": "result-icons/" + (input.isEmpty ? "new-tab" : (isSearch ? "search" : "url")) + ".png"],
        "variables": ["chrome_result_type": input.isEmpty ? "new-tab" : (isSearch ? "search" : "url")],
        "subtitle": input.isEmpty ? "↩ 打开 Chrome 新标签并进入地址栏" : (isSearch ? "↩ 用 Google 搜索" : "↩ 切换已有标签，或打开网址"),
        "arg": try encoded(payload), "valid": true,
        "text": ["copy": url],
        "mods": [
            "cmd": ["valid": true, "subtitle": "另开一个标签", "arg": try encoded(newPayload)],
            "ctrl": ["valid": !input.isEmpty, "subtitle": "复制完整网址", "arg": url]
        ]
    ]
}

func styledResult(_ original: Row) -> Row {
    var row = original
    if row["valid"] as? Bool == false {
        row["icon"] = ["path": "result-icons/warning.png"]
        return row
    }
    let source = row["_source"] as? String ?? (row["_history"] as? Bool == true ? "history" : "bookmark")
    if row["_archived"] as? Bool == true {
        row["subtitle"] = (row["subtitle"] as? String ?? "").replacingOccurrences(of: "书签 · ↩ 打开", with: "归档 · ↩ 打开")
    }
    // Filtering is complete; Alfred does not need the often very large index text.
    row.removeValue(forKey: "match")
    row.removeValue(forKey: "_aliases")
    row.removeValue(forKey: "_source")
    row.removeValue(forKey: "_entry")
    row.removeValue(forKey: "_archived")
    let opened = source.hasPrefix("opened")
    row["icon"] = ["path": "result-icons/" + (opened ? "opened" : source) + ".png"]
    row["variables"] = ["chrome_result_type": source]
    if source == "opened-bookmark" {
        row["subtitle"] = (row["subtitle"] as? String ?? "").replacingOccurrences(of: "已打开 · ↩ 切换", with: "已打开 · 已收藏 · ↩ 切换")
    }
    return row
}

func results(_ index: Row, query: String, history: URL? = nil) throws -> [Row] {
    let input = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let needle = normalized(input)
    let tokens = needle.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    var candidates = index["items"] as? [Row] ?? []
    var historyUnavailable = index["_historyUnavailable"] as? Bool == true
    if !input.isEmpty, let history {
        let started = ProcessInfo.processInfo.systemUptime
        do { candidates = mergeHistory(candidates, try historyRows(history, query: input)) }
        catch { historyUnavailable = true }
        searchPhases["historyQueryMs"] = (ProcessInfo.processInfo.systemUptime - started) * 1000
    }
    // The JXA index already normalizes match strings; only rank titles once.
    let filterStarted = ProcessInfo.processInfo.systemUptime
    var displayedHistory = 0
    var rows = candidates.enumerated().compactMap { offset, row -> (offset: Int, score: Int, row: Row)? in
        let text = row["match"] as? String ?? normalized(row["title"] as? String ?? "")
        if row["valid"] as? Bool != false && !tokens.allSatisfy({ text.contains($0) }) { return nil }
        var score = 3
        if !input.isEmpty {
            let aliases = row["_aliases"] as? [String] ?? []
            let titles = aliases.isEmpty ? [row["title"] as? String ?? ""] : aliases
            for name in titles {
                let title = normalized(name)
                score = min(score, title == needle ? 0 : (title.hasPrefix(needle) ? 1 : (tokens.allSatisfy { title.contains($0) } ? 2 : 3)))
            }
        }
        return (offset, score, row)
    }.sorted { a, b in
        let ah = a.row["_history"] as? Bool == true, bh = b.row["_history"] as? Bool == true
        if ah != bh { return !ah }
        let aa = a.row["_archived"] as? Bool == true, ba = b.row["_archived"] as? Bool == true
        if aa != ba { return !aa }
        return a.score == b.score ? a.offset < b.offset : a.score < b.score
    }.filter { result in
        // Cap history after relevance ranking and full-URL merging. Bookmark/tab
        // aliases found through older historical titles must remain available.
        guard result.row["_history"] as? Bool == true else { return true }
        guard displayedHistory < historyResultLimit else { return false }
        displayedHistory += 1
        return true
    }.prefix(150).map { $0.row }
    if historyUnavailable && !input.isEmpty {
        rows.append(["title": "暂时无法读取 Chrome 历史", "subtitle": "标签和书签仍可搜索；重新唤起后重试", "valid": false])
    }
    let address = try addressRow(input)
    let styled = rows.map(styledResult)
    searchPhases["filterMs"] = (ProcessInfo.processInfo.systemUptime - filterStarted) * 1000
    let numeric = normalized(input)
    let numericSearch = (address["variables"] as? Row)?["chrome_result_type"] as? String == "search" &&
        numeric.range(of: "^[0-9e.()+*/^%=×÷−\\s-]+$", options: .regularExpression) != nil && numeric.contains(where: { $0.isNumber })
    if numericSearch { return [address] + styled }
    return input.isEmpty ? [address] + styled : styled + [address]
}

func readIndex(_ path: String) throws -> Row {
    guard let index = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? Row,
          index["items"] is [Row] else { throw NSError(domain: "ChromeIndex", code: 1) }
    return index
}

func run() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.first == "--activate", args.count == 2 { try activate(args[1]); return }
    if args.first == "--test-snapshot", args.count == 3 {
        let target = try snapshotHistory(to: URL(fileURLWithPath: args[2]), from: URL(fileURLWithPath: args[1]))
        print(try encoded(["database": target.path]))
        return
    }
    if args.first == "--test-index", args.count == 3 || args.count == 4 {
        print(try encoded(["items": results(readIndex(args[1]), query: args[2], history: args.count == 4 ? URL(fileURLWithPath: args[3]) : nil)]))
        return
    }
    let env = ProcessInfo.processInfo.environment
    let query = args.first ?? ""
    timingQuery = query
    timingContext = timingEvent("search_begin", data: ["query": query,
        "session": env["chrome_timing_session"] as Any? ?? NSNull(),
        "processStartedNs": String(diagnosticStartedNs)])
    diagnosticLog(["phase": "begin", "trace": diagnosticTrace, "timeMs": Int(Date().timeIntervalSince1970 * 1000), "queryLength": query.count])
    let nativeStarted = DispatchTime.now().uptimeNanoseconds
    if let (status, native) = bridgeRequest("/index"), status == 200,
       native["kind"] as? String == "index", native["profile"] as? String == configuredProfile(), native["items"] is [Row] {
        searchPhases["nativeIndexMs"] = Double(DispatchTime.now().uptimeNanoseconds - nativeStarted) / 1_000_000
        let fm = FileManager.default
        let cache = URL(fileURLWithPath: env["alfred_workflow_cache"] ?? (NSHomeDirectory() + "/Library/Caches/io.github.noahyao1024.bookmark-workspaces"))
            .appendingPathComponent("search-sessions", isDirectory: true)
        try fm.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let supplied = env["chrome_alias_session"] ?? ""
        let session = UUID(uuidString: supplied) == nil ? UUID().uuidString : supplied
        let path = cache.appendingPathComponent(session)
        if !fm.fileExists(atPath: path.path) {
            var saved = native; saved["_historyVersion"] = 1; saved["_presentationVersion"] = 9
            try JSONSerialization.data(withJSONObject: saved).write(to: path, options: [.atomic])
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            for old in (try? fm.contentsOfDirectory(at: cache, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
                if UUID(uuidString: old.lastPathComponent.replacingOccurrences(of: ".history", with: "")) != nil,
                   let date = try? old.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                   Date().timeIntervalSince(date) > 600 { try? fm.removeItem(at: old) }
            }
        }
        var index = native
        var history: URL?
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let directory = cache.appendingPathComponent(session + ".history", isDirectory: true)
            let database = directory.appendingPathComponent("History")
            let ready = directory.appendingPathComponent(".snapshot-ready")
            // Alfred may terminate a superseded query during a copy. A file
            // appearing on disk alone does not mean that copy was completed.
            if fm.fileExists(atPath: database.path) && fm.fileExists(atPath: ready.path) { history = database }
            else {
                let started = DispatchTime.now().uptimeNanoseconds
                do {
                    history = try snapshotHistory(to: directory)
                    try Data().write(to: ready, options: [.atomic])
                } catch { index["_historyUnavailable"] = true }
                searchPhases["historySnapshotMs"] = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
            }
        }
        try emitSearch(["items": results(index, query: query, history: history),
                        "variables": ["chrome_alias_session": session, "chrome_alias_primed": "1"]],
                       metrics: ["queryLength": query.count, "cacheHit": true, "indexSource": "native", "indexSession": session])
        return
    }
    searchPhases["nativeIndexMs"] = Double(DispatchTime.now().uptimeNanoseconds - nativeStarted) / 1_000_000
    if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
       env["chrome_alias_primed"] != "1", env["chrome_alias_session"] == nil {
        // Make empty-input Return available before any browser round trip.
        try emitSearch(["items": [addressRow("")], "rerun": 0.1,
                        "variables": ["chrome_alias_primed": "1", "chrome_alias_session": UUID().uuidString]],
                       metrics: ["queryLength": query.count, "prime": true])
        return
    }
    let fm = FileManager.default
    let cache = URL(fileURLWithPath: env["alfred_workflow_cache"] ?? (NSHomeDirectory() + "/Library/Caches/io.github.noahyao1024.bookmark-workspaces"))
        .appendingPathComponent("search-sessions", isDirectory: true)
    try fm.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let session = env["chrome_alias_session"] ?? ""
    var path = cache.appendingPathComponent(session).path
    var index: Row?
    let cacheReadStarted = ProcessInfo.processInfo.systemUptime
    if UUID(uuidString: session) != nil,
       let attributes = try? fm.attributesOfItem(atPath: path),
       let modified = attributes[.modificationDate] as? Date,
       Date().timeIntervalSince(modified) < 600 {
        index = try? readIndex(path)
        if index?["_historyVersion"] as? Int != 1 { index = nil }
        if index?["_presentationVersion"] as? Int != 9 { index = nil }
    }
    searchPhases["cacheReadMs"] = (ProcessInfo.processInfo.systemUptime - cacheReadStarted) * 1000
    let cacheHit = index != nil
    var nextSession = session
    if index == nil {
        // The prime response reserves this ID before the first browser read.
        // Typing during that read still carries the prime variables in Alfred.
        // Reusing the ID lets the queued query find the completed snapshot.
        nextSession = UUID(uuidString: session) != nil ? session : UUID().uuidString
        path = cache.appendingPathComponent(nextSession).path
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("chrome-alias.js")
        process.arguments = ["index"]
        process.standardOutput = pipe
        let snapshotStarted = ProcessInfo.processInfo.systemUptime
        try process.run()
        // Chrome's index process is already running. Copy history during that
        // browser round trip rather than adding the copy after it finishes.
        let historyStarted = ProcessInfo.processInfo.systemUptime
        var historyUnavailable = false
        do { _ = try snapshotHistory(to: cache.appendingPathComponent(nextSession + ".history", isDirectory: true)) }
        catch { historyUnavailable = true }
        searchPhases["historySnapshotMs"] = (ProcessInfo.processInfo.systemUptime - historyStarted) * 1000
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        searchPhases["chromeSnapshotMs"] = (ProcessInfo.processInfo.systemUptime - snapshotStarted) * 1000
        guard process.terminationStatus == 0,
              let decoded = try JSONSerialization.jsonObject(with: data) as? Row,
              decoded["items"] is [Row] else { throw NSError(domain: "ChromeIndex", code: 2) }
        index = decoded
        index?["_historyVersion"] = 1
        index?["_presentationVersion"] = 9
        if historyUnavailable { index?["_historyUnavailable"] = true }
        try JSONSerialization.data(withJSONObject: index!).write(to: URL(fileURLWithPath: path), options: [.atomic])
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        // Session files contain titles and URLs; keep only recent invocations.
        for old in (try? fm.contentsOfDirectory(at: cache, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if UUID(uuidString: old.lastPathComponent.replacingOccurrences(of: ".history", with: "")) != nil,
               let date = try? old.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
               Date().timeIntervalSince(date) > 600 { try? fm.removeItem(at: old) }
        }
    }
    let history = index?["_historyUnavailable"] as? Bool == true ? nil : cache.appendingPathComponent(nextSession + ".history/History")
    try emitSearch(["items": results(index!, query: query, history: history), "variables": ["chrome_alias_session": nextSession, "chrome_alias_primed": "1"]],
                   metrics: ["queryLength": query.count, "cacheHit": cacheHit, "indexSession": nextSession])
}

do { try run() } catch {
    if CommandLine.arguments.dropFirst().first == "--activate" {
        diagnosticLog(["phase": "error", "trace": diagnosticTrace, "timeMs": Int(Date().timeIntervalSince1970 * 1000),
                       "errorKind": String(describing: type(of: error))], name: "action-total.jsonl")
        print("{\"kind\":\"failed\",\"reason\":\"activation_error\"}")
        exit(1)
    }
    diagnosticLog(["phase": "error", "trace": diagnosticTrace, "timeMs": Int(Date().timeIntervalSince1970 * 1000),
                   "durationMs": (ProcessInfo.processInfo.systemUptime - diagnosticStarted) * 1000, "errorKind": String(describing: type(of: error))])
    let fallback = (try? addressRow(CommandLine.arguments.dropFirst().first ?? "")) ?? [:]
    let warning: Row = ["title": "暂时无法读取标签和书签", "subtitle": "仍可打开网址或搜索；重新唤起后重试", "valid": false]
    if (try? emitSearch(["items": [fallback, warning]], metrics: ["failed": true])) == nil {
        print("{\"items\":[]}")
    }
}
