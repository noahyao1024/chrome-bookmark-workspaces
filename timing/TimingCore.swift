import Foundation

typealias TimingObject = [String: Any]
func timingNow() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
func timingNS(_ value: Any?) -> UInt64? {
    if let value = value as? String { return UInt64(value) }
    return (value as? NSNumber)?.uint64Value
}
func timingMS(_ start: UInt64?, _ end: UInt64?) -> Double? {
    guard let start, let end, end >= start else { return nil }
    return Double(end - start) / 1_000_000
}
func timingScope(target: String?, foreground: String?) -> String? {
    let supported=["com.google.Chrome","com.runningwithcrayons.Alfred"]
    if let target,supported.contains(target) {return target}
    if let foreground,supported.contains(foreground) {return foreground}
    return nil
}
func timingText(_ value:String)->String {
    value.precomposedStringWithCompatibilityMapping
        .replacingOccurrences(of:"[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF]",with:"",options:.regularExpression)
        .replacingOccurrences(of:"\\s+",with:" ",options:.regularExpression)
        .trimmingCharacters(in:.whitespacesAndNewlines)
}
func timingRowsVisible(_ rows:[[String:String]], texts:Set<String>)->Bool {
    guard !rows.isEmpty else {return false}
    let values=texts.map(timingText),titles=rows.map {timingText($0["title"] ?? "")}
    guard titles.allSatisfy({!$0.isEmpty}) else {return false}
    for (index,row) in rows.enumerated() {
        let title=titles[index]
        guard values.contains(where:{$0==title || $0.contains(title)}) else {return false}
        // Duplicate titles require their distinct subtitles. A unique visible
        // title can confirm a row on Alfred versions that do not expose subtext.
        if titles.filter({$0==title}).count>1 {
            let subtitle=timingText(row["subtitle"] ?? "")
            guard !subtitle.isEmpty,values.contains(where:{$0.contains(subtitle)}) else {return false}
        }
    }
    return true
}

struct TimingKey {
    let id: String
    let kind: String
    let ns: UInt64
    let capturedNs: UInt64
    let interaction: String?
    let source: String
    let sourcePID: Int32
}
struct TimingInput {
    let value: String
    let key: TimingKey?
    let reason: String?
    let observedNs: UInt64
    let interaction: String
}
final class TimingOperation {
    let id = UUID().uuidString
    let kind: String
    let interaction: String
    var key: TimingKey?
    var missing: Set<String> = []
    var traces: [String] = []
    var stages: [String: UInt64] = [:]
    var query = ""
    var queryLength = 0
    var rows: [[String: String]] = []
    var placeholderRows: [[String: String]] = []
    var expectedURL = ""
    var expectedTitle = ""
    var clipboardBaseline: Int?
    var uiArmed = false
    var targetConfirmed = false
    var finished = false
    let createdNs: UInt64
    var resultKind = ""
    var firstUIRecorded = false
    var route = ""
    init(kind: String, interaction: String, key: TimingKey?, now: UInt64) {
        self.kind=kind;self.interaction=interaction;self.key=key;self.createdNs=now
    }
    func record(status: String, end: String? = nil) -> TimingObject {
        let endNS=end.flatMap { stages[$0] }
        let elapsed=timingMS(key?.ns,endNS)
        var metrics: [String: Double] = [:]
        for (stage, ns) in stages { if let ms=timingMS(key?.ns,ns) { metrics[stage]=ms } }
        var record: TimingObject = ["schema":2,"timeMs":Int(Date().timeIntervalSince1970*1000),
            "operation":id,"interaction":interaction,"kind":kind,"status":status,
            "traces":traces,"startBasis":key?.source == "appkit-ns" ? "NSEvent.keyDown.timestamp" : "CGEvent.keyDown.timestamp","queryLength":queryLength,
            "keySource":key?.source ?? NSNull(),"keySourcePID":key.map {Int($0.sourcePID)} as Any? ?? NSNull(),
            "keydownUptimeNs":key.map { String($0.ns) } ?? NSNull(),
            "keyEvent":key?.id ?? NSNull(),"keyKind":key?.kind ?? NSNull(),
            "keydownToStagesMs":metrics,"e2eMs":elapsed as Any? ?? NSNull(),
            "stageUptimeNs":stages.mapValues {String($0)},
            "stageClock":"collector_and_client_mach_uptime","browserStageBasis":"collector_receive_time",
            "completionSignal":end ?? NSNull(),"missing":Array(missing).sorted(),
            "physicalPaintMeasured":false,"route":route,"resultKind":resultKind]
        if let key { record["keyCaptureDelayMs"]=timingMS(key.ns,key.capturedNs) }
        if end?.contains("ax_") == true {
            record["endBasis"]="foreground on-screen window and matching accessibility content"
            record["observation"]="sampled semantic UI visibility; not a physical display timestamp"
        }
        if end == "results_pixels_visible" {
            record["endBasis"]="Alfred window pixels: query region and result titles matched locally"
            record["renderedPixelsConfirmed"]=true
            record["observation"]="first matching sampled capture; capture receipt is an upper-bound observation, OCR time excluded"
        }
        return record
    }
}

// Runs on the collector's main queue. No typed characters or page data enter logs.
final class TimingEngine {
    var emit: (TimingObject) -> Void
    var keyboardAllowed=false
    var accessibilityAllowed=false
    var interaction: String?
    var invocation: TimingKey?
    var invocationFinished=false
    var buffered: [TimingKey] = []
    var inputs: [TimingInput] = []
    var operations: [String: TimingOperation] = [:]
    var traceOperations: [String: String] = [:]
    var usedKeys: Set<String> = []
    var loggedKeys: Set<String> = []
    init(emit: @escaping (TimingObject)->Void) { self.emit=emit }

    @discardableResult func capture(_ kind: String, ns: UInt64, captured: UInt64, source: String = "cg-event", sourcePID: Int32 = 0) -> TimingKey {
        if kind == "invoke" { interaction=UUID().uuidString;invocationFinished=false;inputs=[] }
        let key=TimingKey(id:UUID().uuidString,kind:kind,ns:ns,capturedNs:captured,interaction:interaction,source:source,sourcePID:sourcePID)
        buffered.append(key);buffered=Array(buffered.suffix(128))
        if kind == "invoke" { invocation=key;logKey(key) }
        if kind == "mru" || (interaction != nil && ["accept","accept_new","copy"].contains(kind)) { logKey(key) }
        return key
    }
    func logKey(_ key: TimingKey) {
        guard loggedKeys.insert(key.id).inserted else { return }
        emit(["schema":1,"phase":"keydown","timeMs":Int(Date().timeIntervalSince1970*1000),
              "keyEvent":key.id,"kind":key.kind,"keydownUptimeNs":String(key.ns),
              "keySource":key.source,"keySourcePID":Int(key.sourcePID),
              "captureDelayMs":timingMS(key.ns,key.capturedNs) as Any? ?? NSNull()])
    }
    func inputChanged(_ value: String, keys: [TimingKey], observed: UInt64, sampleStarted: UInt64? = nil) {
        if interaction == nil && value.hasPrefix("t ") {
            interaction=UUID().uuidString;invocationFinished=false
            if keys.count == 1 { invocation=keys[0] }
        }
        guard interaction != nil else { return }
        let key=keys.count == 1 ? keys[0] : nil
        for event in keys { logKey(event) }
        inputs.append(TimingInput(value:value,key:key,reason:key == nil ? "coalesced_or_unobserved_input" : nil,observedNs:observed,interaction:interaction!))
        inputs=Array(inputs.suffix(64))
        for operation in operations.values where operation.kind == "search" && !operation.finished {
            guard (sampleStarted ?? observed) >= operation.createdNs else {continue}
            if !queryMatches(value,operation.query) {
                if keys.contains(where:{$0.ns > (operation.key?.ns ?? operation.createdNs)}) {
                    operation.missing.insert("superseded_by_new_input")
                    operation.stages["superseded_at"]=keys.filter {$0.ns > (operation.key?.ns ?? operation.createdNs)}.map(\.ns).min()
                    finish(operation,status:"superseded")
                }
            } else if operation.key == nil,let key,key.ns <= (operation.stages["process_started"] ?? 0),keyboardAllowed {
                operation.key=key
                operation.missing.remove("no_matching_keydown");operation.missing.remove("coalesced_or_unobserved_input")
            }
        }
    }
    func queryMatches(_ value: String, _ query: String) -> Bool {
        let shown=timingText(value),expected=timingText(query)
        if expected.isEmpty {return shown.isEmpty || shown == "t"}
        return shown == expected || shown == "t " + expected
    }
    func beginSearch(trace: String, query: String, inherited: String?, at: UInt64) -> TimingOperation {
        let session=inherited ?? interaction ?? UUID().uuidString
        interaction=session
        let stamp=inputs.reversed().first { $0.interaction == session && queryMatches($0.value,query) && $0.observedNs <= timingNow() }
        let candidate: TimingKey? = query.isEmpty && invocation?.interaction == session ? invocation : stamp?.key
        let key=candidate.flatMap { $0.ns <= at ? $0 : nil }
        if let existing=operations.values.first(where: { $0.kind == "search" && !$0.finished && $0.interaction == session && $0.query == query && $0.key?.id == key?.id }) {
            existing.traces.append(trace);traceOperations[trace]=existing.id
            existing.stages["latest_process_started"]=at
            return existing
        }
        let op=TimingOperation(kind:"search",interaction:session,key:key,now:at)
        op.query=query;op.queryLength=query.count;op.traces=[trace];op.stages["process_started"]=at
        if !keyboardAllowed { op.missing.insert("input_monitoring_permission_or_event_tap") }
        else if key == nil { op.missing.insert(stamp?.reason ?? "no_matching_keydown") }
        if !accessibilityAllowed { op.missing.insert("accessibility_permission") }
        if let key { logKey(key) }
        operations[op.id]=op;traceOperations[trace]=op.id
        return op
    }
    func beginAction(trace: String, kind: String, at: UInt64, payload: TimingObject, baseline: Int? = nil) -> TimingOperation {
        let source=traceOperations[trace].flatMap { operations[$0] }
        let session=source?.interaction ?? interaction ?? UUID().uuidString
        let allowed=kind == "copy" ? ["copy"] : kind == "mru" ? ["mru"] : ["accept","accept_new"]
        let possible=buffered.filter { allowed.contains($0.kind) && !usedKeys.contains($0.id) && $0.ns <= at && at-$0.ns < 30_000_000_000 && (kind == "mru" || $0.interaction == session) }
        let key=possible.count == 1 ? possible[0] : nil
        for event in possible { usedKeys.insert(event.id) }
        let op=TimingOperation(kind:kind,interaction:session,key:key,now:at)
        op.traces=trace.isEmpty ? [] : [trace];op.expectedURL=payload["url"] as? String ?? ""
        op.stages["action_started"]=at;op.clipboardBaseline=baseline;op.uiArmed=true
        if !keyboardAllowed { op.missing.insert("input_monitoring_permission_or_event_tap") }
        else if key == nil { op.missing.insert(possible.count > 1 ? "ambiguous_keydown" : "no_matching_keydown") }
        if kind != "copy" && !accessibilityAllowed { op.missing.insert("accessibility_permission") }
        if let key { logKey(key) }
        operations[op.id]=op
        return op
    }
    func finish(_ op: TimingOperation, status: String, end: String? = nil) {
        guard !op.finished else { return }
        op.finished=true
        if end != nil && op.key == nil { op.missing.insert("keydown_unavailable") }
        let invalidClock=end != nil && op.key != nil && timingMS(op.key?.ns,end.flatMap { op.stages[$0] }) == nil
        if invalidClock {op.missing.insert("non_monotonic_timestamps")}
        emit(op.record(status:(op.key == nil || invalidClock) && status == "measured" ? "unmeasured" : status,end:end))
        if op.kind == "search", ["results_ax_visible","results_pixels_visible"].contains(end ?? ""), !invocationFinished, let key=invocation,
           key.ns <= (op.stages[end!] ?? 0) {
            let initial=TimingOperation(kind:"invoke",interaction:op.interaction,key:key,now:key.ns)
            initial.traces=op.traces;initial.stages=op.stages
            emit(initial.record(status:"measured",end:end));invocationFinished=true
        }
        // Keep only the data needed to correlate a later Return with this result.
        op.query="";op.rows=[];op.placeholderRows=[];op.expectedURL="";op.expectedTitle=""
    }
    func cancelSearch() {
        for op in operations.values where op.kind == "search" && !op.finished {
            op.missing.insert("search_dismissed");finish(op,status:"cancelled")
        }
        interaction=nil;invocation=nil;inputs=[]
    }
    func expire(now: UInt64) {
        for op in operations.values where !op.finished && now >= op.createdNs && now-op.createdNs > 15_000_000_000 {
            op.missing.insert(op.kind == "copy" ? "clipboard_not_confirmed" : "ui_completion_not_confirmed")
            finish(op,status:"partial")
        }
        let stale=operations.values.filter { $0.finished && now >= $0.createdNs && now-$0.createdNs > 120_000_000_000 }.map(\.id)
        for id in stale { operations.removeValue(forKey:id) }
        traceOperations=traceOperations.filter { operations[$0.value] != nil }
        buffered.removeAll { now >= $0.ns && now-$0.ns > 30_000_000_000 }
        let alive=Set(buffered.map(\.id));usedKeys.formIntersection(alive);loggedKeys.formIntersection(alive)
    }
}
