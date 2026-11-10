import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

func timingScreenLocked()->Bool {
    guard let session=CGSessionCopyCurrentDictionary() as? [String:Any] else {return true}
    return (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true
}

@_silgen_name("chrome_timing_exchange")
func timingExchange(_ path: UnsafePointer<CChar>, _ message: UnsafePointer<CChar>, _ reply: UnsafeMutablePointer<CChar>, _ capacity: Int32, _ timeout: Int32) -> Int32

final class TimingLog {
    let directory=URL(fileURLWithPath:NSHomeDirectory()+"/Library/Logs/BookmarkWorkspaces")
    func write(_ record: TimingObject, file: String="e2e.jsonl") {
        do {
            let fm=FileManager.default
            try fm.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let url=directory.appendingPathComponent(file)
            if let size=(try? fm.attributesOfItem(atPath:url.path)[.size]) as? NSNumber, size.intValue>1_048_576 {
                let old=url.appendingPathExtension("1");try? fm.removeItem(at:old);try fm.moveItem(at:url,to:old)
            }
            if !fm.fileExists(atPath:url.path) { fm.createFile(atPath:url.path,contents:nil,attributes:[.posixPermissions:0o600]) }
            let handle=try FileHandle(forWritingTo:url);defer {try? handle.close()}
            try handle.seekToEnd();var bytes=try JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]);bytes.append(10)
            try handle.write(contentsOf:bytes)
        } catch { /* Logging cannot affect keyboard dispatch. */ }
    }
}

final class TimingSocket {
    var listener:Int32 = -1
    var source:DispatchSourceRead?
    let path:String
    var receive:((TimingObject,@escaping(TimingObject)->Void)->Void)?
    init(path:String){self.path=path}
    func start() throws {
        unlink(path);listener=socket(AF_UNIX,SOCK_STREAM,0)
        guard listener>=0 else {throw NSError(domain:"TimingSocket",code:1)}
        var address=sockaddr_un();address.sun_family=sa_family_t(AF_UNIX)
        let size=MemoryLayout.size(ofValue:address.sun_path)
        guard path.utf8.count<size else {throw NSError(domain:"TimingSocket",code:2)}
        _ = withUnsafeMutablePointer(to:&address.sun_path) { pointer in
            pointer.withMemoryRebound(to:CChar.self,capacity:size) { strcpy($0,path) }
        }
        let bound=withUnsafePointer(to:&address) { pointer in
            pointer.withMemoryRebound(to:sockaddr.self,capacity:1) { Darwin.bind(listener,$0,socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound==0 && listen(listener,16)==0 else {throw NSError(domain:"TimingSocket",code:3)}
        chmod(path,0o600);_ = fcntl(listener,F_SETFL,O_NONBLOCK)
        source=DispatchSource.makeReadSource(fileDescriptor:listener,queue:DispatchQueue.global(qos:.userInitiated))
        source?.setEventHandler { [weak self] in
            guard let self else {return}
            while true {
                let fd=accept(self.listener,nil,nil);if fd<0 {break}
                DispatchQueue.global(qos:.userInitiated).async {self.read(fd)}
            }
        }
        source?.resume()
    }
    func read(_ fd:Int32) {
        var timeout=timeval(tv_sec:0,tv_usec:100_000),one:Int32=1
        setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&one,socklen_t(MemoryLayout<Int32>.size))
        var data=Data(),chunk=[UInt8](repeating:0,count:4096)
        while data.count<=60_000 {
            let n=Darwin.read(fd,&chunk,chunk.count)
            if n<=0 {break};data.append(contentsOf:chunk.prefix(n))
            if data.last==10 {break}
        }
        guard data.count<=60_000,let object=(try? JSONSerialization.jsonObject(with:data)) as? TimingObject else {close(fd);return}
        DispatchQueue.main.async { [weak self] in
            self?.receive?(object) { reply in
                DispatchQueue.global(qos:.userInitiated).async {
                    var bytes=(try? JSONSerialization.data(withJSONObject:reply)) ?? Data("{}".utf8);bytes.append(10)
                    bytes.withUnsafeBytes { buffer in _=Darwin.write(fd,buffer.baseAddress,buffer.count) }
                    close(fd)
                }
            }
        }
    }
}

final class KeyboardTap {
    var port:CFMachPort?
    var running=false
    var location="not_created"
    let requestedLocation:CGEventTapLocation
    let locationName:String
    init(_ point:CGEventTapLocation = .cghidEventTap,name:String = "hid") {requestedLocation=point;locationName=name}
    var onKey:((UInt64,UInt64,Int64,UInt64,pid_t,pid_t)->Void)?
    var onGap:(()->Void)?
    func start() {
        guard !running else {return};running=true
        Thread.detachNewThread { [self] in
            let mask=CGEventMask(1)<<CGEventType.keyDown.rawValue
            // Observe before input methods can consume/repost the physical key.
            port=CGEvent.tapCreate(tap:requestedLocation,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:{ _,type,event,pointer in
                guard let pointer else {return Unmanaged.passUnretained(event)}
                let monitor=Unmanaged<KeyboardTap>.fromOpaque(pointer).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    if let port=monitor.port {CGEvent.tapEnable(tap:port,enable:true)}
                    DispatchQueue.main.async {monitor.onGap?()}
                } else if type == .keyDown {
                    let ns=event.timestamp,captured=timingNow(),code=event.getIntegerValueField(.keyboardEventKeycode)
                    let flags=event.flags.rawValue,pid=pid_t(event.getIntegerValueField(.eventTargetUnixProcessID))
                    let sourcePID=pid_t(event.getIntegerValueField(.eventSourceUnixProcessID))
                    // No character extraction, disk I/O or AX calls in the event tap.
                    DispatchQueue.main.async {monitor.onKey?(ns,captured,code,flags,pid,sourcePID)}
                }
                return Unmanaged.passUnretained(event)
            },userInfo:Unmanaged.passUnretained(self).toOpaque())
            guard let port else {DispatchQueue.main.async {self.running=false};return}
            location=locationName
            let source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,port,0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(),source,.commonModes);CGEvent.tapEnable(tap:port,enable:true)
            CFRunLoopRun()
        }
    }
}

func axValue(_ element:AXUIElement,_ key:String)->CFTypeRef? {
    var value:CFTypeRef?;guard AXUIElementCopyAttributeValue(element,key as CFString,&value) == .success else {return nil};return value
}
func axElement(_ value:CFTypeRef?)->AXUIElement? {
    guard let value,CFGetTypeID(value)==AXUIElementGetTypeID() else {return nil};return (value as! AXUIElement)
}
func axString(_ value:CFTypeRef?)->String? {
    if let value=value as? String {return value}
    if let value=value as? URL {return value.absoluteString}
    return nil
}
func axFrame(_ element:AXUIElement)->CGRect? {
    guard let p=axValue(element,kAXPositionAttribute),CFGetTypeID(p)==AXValueGetTypeID(),
          let s=axValue(element,kAXSizeAttribute),CFGetTypeID(s)==AXValueGetTypeID() else {return nil}
    var point=CGPoint.zero,size=CGSize.zero
    guard AXValueGetValue(p as! AXValue,.cgPoint,&point),AXValueGetValue(s as! AXValue,.cgSize,&size) else {return nil}
    return CGRect(origin:point,size:size)
}
struct UIReading {
    var start=timingNow(),end=timingNow()
    var pid:pid_t=0,bundle="",onScreen=false
    var input:String?,document:String?,title:String?
    var strings:Set<String>=[]
    var exhausted=false
    var roleCounts:[String:Int]=[:]
    var enhancedModeResult:Int32?
    var windowFrame:CGRect?,inputFrame:CGRect?
}
final class UIProbe {
    static var enhancedModes:[pid_t:Int32]=[:]
    static func read(pid:pid_t,bundle:String)->UIReading {
        var result=UIReading();result.pid=pid;result.bundle=bundle
        defer {result.end=timingNow()}
        let app=AXUIElementCreateApplication(pid);AXUIElementSetMessagingTimeout(app,0.03)
        if bundle == "com.runningwithcrayons.Alfred" {
            if enhancedModes[pid] == nil {enhancedModes[pid]=AXUIElementSetAttributeValue(app,"AXEnhancedUserInterface" as CFString,kCFBooleanTrue).rawValue}
            result.enhancedModeResult=enhancedModes[pid]
        }
        guard let window=axElement(axValue(app,kAXFocusedWindowAttribute)) ?? (axValue(app,kAXWindowsAttribute) as? [AXUIElement])?.first else {result.end=timingNow();return result}
        let windows=CGWindowListCopyWindowInfo(.optionOnScreenOnly,kCGNullWindowID) as? [[String:Any]] ?? []
        result.onScreen=windows.contains { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value==pid && ($0[kCGWindowAlpha as String] as? Double ?? 1)>0 }
        result.title=axString(axValue(window,kAXTitleAttribute))
        result.windowFrame=axFrame(window)
        if bundle == "com.runningwithcrayons.Alfred" {
            var fields:[AXUIElement]=[]
            if let focused=axElement(axValue(app,kAXFocusedUIElementAttribute)),axString(axValue(focused,kAXRoleAttribute)) == kAXTextFieldRole {fields.append(focused)}
            var scan=[window],i=0
            while i<scan.count && i<40 {
                let node=scan[i];i+=1
                if axString(axValue(node,kAXRoleAttribute)) == kAXTextFieldRole {fields.append(node)}
                if let children=axValue(node,kAXChildrenAttribute) as? [AXUIElement] {scan.append(contentsOf:children.prefix(30))}
            }
            if let input=fields.first(where:{axString(axValue($0,kAXSubroleAttribute)) != kAXSecureTextFieldSubrole}) {
                result.input=axString(axValue(input,kAXValueAttribute))
                result.inputFrame=axFrame(input)
            }
        } else if bundle == "com.google.Chrome" {
            result.document=axString(axValue(window,kAXDocumentAttribute))
            if result.document != nil {result.end=timingNow();return result}
        }
        var queue=[window],offset=0
        while offset<queue.count && offset<160 && timingNow()-result.start<60_000_000 {
            let node=queue[offset];offset+=1
            let role=axString(axValue(node,kAXRoleAttribute)) ?? ""
            result.roleCounts[role,default:0]+=1
            if bundle == "com.google.Chrome" {
                if role == "AXWebArea" {
                    result.document=axString(axValue(node,"AXURL")) ?? axString(axValue(node,kAXDocumentAttribute))
                    if result.document != nil {break}
                    continue // Never traverse page text for timing.
                }
            } else if [kAXTextFieldRole,kAXTextAreaRole].contains(role) {
                continue // Input text cannot serve as evidence that a result appeared.
            } else if role == kAXComboBoxRole {
                // A combo box can own the result list as well as its input.
                // Skip its editable value, but continue through its children.
            } else if role != kAXWindowRole && role != kAXApplicationRole {
                for name in [kAXTitleAttribute,kAXValueAttribute,kAXDescriptionAttribute] {
                    if let text=axString(axValue(node,name)),!text.isEmpty,text.utf8.count<16_384 {result.strings.insert(text)}
                }
            }
            if let children=axValue(node,kAXChildrenAttribute) as? [AXUIElement] {queue.append(contentsOf:children.prefix(80))}
        }
        result.exhausted=offset<queue.count;result.end=timingNow();return result
    }
}

final class Collector:NSObject,NSApplicationDelegate {
    let log=TimingLog()
    lazy var engine=TimingEngine { [weak self] in self?.log.write($0) }
    let keyboard=KeyboardTap()
    let deliveredKeyboard=KeyboardTap(.cgAnnotatedSessionEventTap,name:"annotated")
    var appKitMonitor:Any?
    let cache=URL(fileURLWithPath:NSHomeDirectory()+"/Library/Caches/BookmarkWorkspaces")
    var socket:TimingSocket?
    var timer:Timer?
    var lastHealth:UInt64=0,lastProbe:UInt64=0,lastAlfred:UInt64=0
    var probeRunning=false
    var pendingEdits:[TimingKey]=[]
    var lastInput:String?
    var focusHistory:[(UInt64,pid_t,String)]=[]
    var browserOperations:[String:String]=[:]
    var maxProbeMs:Double=0
    var lastProbeSummary:TimingObject=[:]
    var lastAlfredProbeSummary:TimingObject=[:]
    var keyCallbacks=0,scopedKeyCallbacks=0
    var lastRouting:TimingObject=[:]
    var keyBackends:[String:Int]=[:]
    var clockMismatchCount=0,lastClockMismatchLog:UInt64=0
    var acceptedKeySignatures:[(UInt64,Int64,UInt64)]=[]
    var pixelRunning=false,lastPixelStart:UInt64=0
    var lastPixelSummary:TimingObject=[:]
    var previousLockState=timingScreenLocked()
    func applicationDidFinishLaunching(_ notification:Notification) {
        signal(SIGPIPE,SIG_IGN)
        try? FileManager.default.createDirectory(at:cache,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        socket=TimingSocket(path:cache.appendingPathComponent("timing.sock").path)
        socket?.receive={ [weak self] message,reply in self?.receive(message,reply:reply) }
        do {try socket?.start()} catch {NSApp.terminate(nil);return}
        updateFocus()
        NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { [weak self] _ in self?.updateFocus() }
        keyboard.onKey={ [weak self] in self?.keydown(ns:$0,captured:$1,code:$2,flags:$3,target:$4,sourcePID:$5,source:"hid") }
        deliveredKeyboard.onKey={ [weak self] in self?.keydown(ns:$0,captured:$1,code:$2,flags:$3,target:$4,sourcePID:$5,source:"annotated") }
        keyboard.onGap={ [weak self] in
            guard let self else {return}
            self.engine.cancelSearch();self.pendingEdits=[]
            self.log.write(["event":"event_tap_gap","timeMs":Int(Date().timeIntervalSince1970*1000)],file:"e2e-health.jsonl")
        }
        deliveredKeyboard.onGap=keyboard.onGap
        refreshPermissions()
        timer=Timer.scheduledTimer(withTimeInterval:0.02,repeats:true) { [weak self] _ in self?.tick() }
    }
    func updateFocus() {
        if let app=NSWorkspace.shared.frontmostApplication {
            focusHistory.append((timingNow(),app.processIdentifier,app.bundleIdentifier ?? ""));focusHistory=Array(focusHistory.suffix(16))
        }
    }
    func focusedApplication()->NSRunningApplication? {
        if engine.accessibilityAllowed,let app=axElement(axValue(AXUIElementCreateSystemWide(),kAXFocusedApplicationAttribute)) {
            var pid:pid_t=0
            if AXUIElementGetPid(app,&pid) == .success,let running=NSRunningApplication(processIdentifier:pid) {return running}
        }
        return NSWorkspace.shared.frontmostApplication
    }
    func keydown(ns:UInt64,captured:UInt64,code:Int64,flags:UInt64,target:pid_t,sourcePID:pid_t=0,source:String="hid") {
        guard !timingScreenLocked() else {return}
        keyCallbacks+=1
        keyBackends[source,default:0]+=1
        guard captured>=ns,captured-ns<5_000_000_000 else {
            clockMismatchCount+=1
            // A reposted/stale event is still rejected. Aggregate diagnostics so
            // unrelated keyboard traffic cannot cause disk I/O on every key.
            let now=timingNow()
            if now-lastClockMismatchLog>5_000_000_000 {
                log.write(["event":"keyboard_clock_mismatch","count":clockMismatchCount,"source":source,
                           "reason":captured<ns ? "timestamp_ahead" : "timestamp_older_than_five_seconds",
                           "timeMs":Int(Date().timeIntervalSince1970*1000)],file:"e2e-health.jsonl")
                lastClockMismatchLog=now
            }
            return
        }
        if keyboard.port != nil || deliveredKeyboard.port != nil || appKitMonitor != nil {engine.keyboardAllowed=true}
        let history=focusHistory.last { $0.0<=ns } ?? focusHistory.last
        let targetBundle=target>0 ? NSRunningApplication(processIdentifier:target)?.bundleIdentifier : nil
        guard let bundle=timingScope(target:targetBundle,foreground:history?.2) else {return}
        scopedKeyCallbacks+=1
        lastRouting=["targetBundle":targetBundle ?? "none","foregroundBundle":history?.2 ?? "none","resolvedScope":bundle]
        let command=flags & CGEventFlags.maskCommand.rawValue != 0
        let control=flags & CGEventFlags.maskControl.rawValue != 0
        let option=flags & CGEventFlags.maskAlternate.rawValue != 0
        let shift=flags & CGEventFlags.maskShift.rawValue != 0
        let signatureFlags=flags & (CGEventFlags.maskCommand.rawValue|CGEventFlags.maskControl.rawValue|CGEventFlags.maskAlternate.rawValue|CGEventFlags.maskShift.rawValue|CGEventFlags.maskAlphaShift.rawValue)
        // The same OS event may be seen at HID, annotated and AppKit layers.
        // Only identical event clocks (within double conversion rounding) merge.
        if acceptedKeySignatures.contains(where:{ abs(Double($0.0)-Double(ns))<=1000 && $0.1==code && $0.2==signatureFlags }) {return}
        var accepted=false
        if bundle == "com.google.Chrome" {
            if code==17 && command && !control && !option && !shift {
                _=engine.capture("invoke",ns:ns,captured:captured,source:source,sourcePID:sourcePID);pendingEdits=[];lastInput=nil;accepted=true
            } else if code==48 && control && !command && !option && !shift { _=engine.capture("mru",ns:ns,captured:captured,source:source,sourcePID:sourcePID);accepted=true }
        } else if bundle == "com.runningwithcrayons.Alfred" {
            if code==53 {engine.cancelSearch();pendingEdits=[];lastInput=nil;return}
            if code==36 || code==76 {
                if !(command && control) && !option {
                    _=engine.capture(control ? "copy" : command ? "accept_new" : "accept",ns:ns,captured:captured,source:source,sourcePID:sourcePID);accepted=true
                }
            } else if (code<=51 || code==117) && !control && (!option || code==51 || code==117) && (!command || [6,7,9,51,117].contains(code)) {
                pendingEdits.append(engine.capture("edit",ns:ns,captured:captured,source:source,sourcePID:sourcePID));pendingEdits=Array(pendingEdits.suffix(32));accepted=true
            }
        }
        if accepted {acceptedKeySignatures.append((ns,code,signatureFlags));acceptedKeySignatures=Array(acceptedKeySignatures.suffix(128))}
    }
    func refreshPermissions() {
        let listen=CGPreflightListenEventAccess(),ax=AXIsProcessTrusted()
        let locked=timingScreenLocked()
        let captureReady=keyboard.port != nil || deliveredKeyboard.port != nil || appKitMonitor != nil
        engine.keyboardAllowed=listen && captureReady;engine.accessibilityAllowed=ax
        if listen && !locked {keyboard.start();deliveredKeyboard.start()}
        if ax && listen && !locked && appKitMonitor == nil {
            appKitMonitor=NSEvent.addGlobalMonitorForEvents(matching:.keyDown) { [weak self] event in
                let cg=event.cgEvent
                let ns=cg?.timestamp ?? UInt64(event.timestamp*1_000_000_000)
                self?.keydown(ns:ns,captured:timingNow(),code:Int64(event.keyCode),flags:UInt64(event.modifierFlags.rawValue),
                    target:cg.map {pid_t($0.getIntegerValueField(.eventTargetUnixProcessID))} ?? 0,
                    sourcePID:cg.map {pid_t($0.getIntegerValueField(.eventSourceUnixProcessID))} ?? 0,
                    source:cg == nil ? "appkit-ns" : "appkit-cg")
            }
        }
        let state:TimingObject=["pid":ProcessInfo.processInfo.processIdentifier,"timeMs":Int(Date().timeIntervalSince1970*1000),
            "inputMonitoring":listen,"accessibility":ax,"eventTapRunning":captureReady,
            "screenCapture":CGPreflightScreenCaptureAccess(),
            "screenLocked":locked,
            "lastPixelProbe":lastPixelSummary,
            "ready":listen && ax && captureReady,"uiObservation":"accessibility_on_screen","physicalPaintMeasured":false,
            "maxAXProbeMs":maxProbeMs,"lastUIProbe":lastProbeSummary,"lastAlfredProbe":lastAlfredProbeSummary,"keyboardTapLocation":keyboard.location,
            "keydownCallbacks":keyCallbacks,"scopedKeydownCallbacks":scopedKeyCallbacks,"lastRouting":lastRouting,
            "clockMismatchCount":clockMismatchCount,
            "keyboardBackends":keyBackends,"annotatedTap":deliveredKeyboard.port != nil,"appKitMonitor":appKitMonitor != nil]
        if let data=try? JSONSerialization.data(withJSONObject:state,options:[.prettyPrinted]) {try? data.write(to:cache.appendingPathComponent("timing-health.json"),options:.atomic)}
        lastHealth=timingNow()
    }
    func requestPermissions() {
        NSApp.activate(ignoringOtherApps:true)
        _=AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
        _=CGRequestListenEventAccess();refreshPermissions()
    }
    func operation(_ message:TimingObject)->TimingOperation? {
        if let id=(message["context"] as? TimingObject)?["op"] as? String {return engine.operations[id]}
        if let trace=message["trace"] as? String {
            return engine.operations.values.filter { $0.traces.contains(trace) && !$0.finished }.sorted { $0.createdNs>$1.createdNs }.first
        }
        return nil
    }
    func receive(_ message:TimingObject,reply:@escaping(TimingObject)->Void) {
        let type=message["type"] as? String ?? "",trace=message["trace"] as? String ?? ""
        // Native-host Python monotonic clocks are not assumed to share the
        // CGEvent/Dispatch epoch. Browser signals use local receive timestamps.
        let data=message["data"] as? TimingObject ?? [:]
        let at=type == "browser_event" ? timingNow() : (timingNS(message["atNs"]) ?? timingNow())
        guard at<=timingNow()+1_000_000_000 else {reply([:]);return}
        switch type {
        case "health":
            refreshPermissions();reply(["inputMonitoring":CGPreflightListenEventAccess(),"accessibility":engine.accessibilityAllowed,"eventTapRunning":keyboard.port != nil || deliveredKeyboard.port != nil || appKitMonitor != nil,"screenCapture":CGPreflightScreenCaptureAccess()]);return
        case "request_permissions":reply(["requested":true]);requestPermissions();return
        case "request_screen_permission":reply(["requested":true]);NSApp.activate(ignoringOtherApps:true);_ = CGRequestScreenCaptureAccess();return
        case "search_begin":
            let op=engine.beginSearch(trace:trace,query:data["query"] as? String ?? "",inherited:data["session"] as? String,at:timingNS(data["processStartedNs"]) ?? at)
            reply(["op":op.id,"session":op.interaction,"keydownAvailable":op.key != nil]);return
        case "search_prepared":
            if let op=operation(message),!op.finished {
                let rows=data["rows"] as? [[String:String]] ?? []
                if data["placeholder"] as? Bool == true {op.placeholderRows=rows;op.stages["placeholder_prepared"]=at}
                else {op.rows=rows;op.stages["results_prepared"]=at}
            }
        case "search_written":
            if let op=operation(message),!op.finished {
                op.stages[data["placeholder"] as? Bool == true ? "placeholder_written" : "output_written"]=at;op.uiArmed=true
            }
        case "action_begin", "copy_begin":
            let kind=type == "copy_begin" ? "copy" : "open"
            let op=engine.beginAction(trace:trace,kind:kind,at:at,payload:data,baseline:kind == "copy" ? NSPasteboard.general.changeCount : nil)
            if kind == "open" && (data["tabId"] == nil || data["forceNew"] as? Bool == true) {armBrowser(op)}
            reply(["op":op.id,"session":op.interaction,"keydownAvailable":op.key != nil]);return
        case "action_end":
            if let op=operation(message),!op.finished {
                op.stages["action_completed"]=at
                let status=message["status"] as? TimingObject ?? [:]
                op.route=status["route"] as? String ?? "";op.resultKind=data["kind"] as? String ?? ""
                if (status["exitCode"] as? Int ?? 0) != 0 {op.missing.insert("action_failed");engine.finish(op,status:"failed")}
                else if data["kind"] as? String == "focused" {
                    op.expectedURL=data["targetURL"] as? String ?? op.expectedURL;op.expectedTitle=data["targetTitle"] as? String ?? ""
                    op.targetConfirmed=true;op.stages["target_activation_acknowledged"]=at
                }
                maybeFinishOpen(op)
            }
        case "browser_event":browserEvent(data,at:at)
        default:break
        }
        reply([:])
    }
    func armBrowser(_ op:TimingOperation) {
        guard !op.expectedURL.isEmpty else {return}
        let request:TimingObject=["operation":op.id,"url":op.expectedURL,"expiresAt":Int(Date().timeIntervalSince1970*1000)+15000]
        DispatchQueue.global(qos:.userInitiated).async { [cache] in
            guard let body=try? JSONSerialization.data(withJSONObject:request),let json=String(data:body,encoding:.utf8) else {return}
            let wire="POST /timing/arm HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n"+json
            var response=[CChar](repeating:0,count:4096)
            _=cache.appendingPathComponent("native.sock").path.withCString { path in wire.withCString {timingExchange(path,$0,&response,Int32(response.count),20)} }
        }
    }
    func browserEvent(_ data:TimingObject,at:UInt64) {
        let event=data["event"] as? String ?? ""
        if event == "mru_begin",let nonce=data["nonce"] as? String {
            let op=engine.beginAction(trace:"mru-"+nonce,kind:"mru",at:at,payload:[:]);browserOperations[nonce]=op.id
        }
        let id=(data["operation"] as? String) ?? (data["nonce"] as? String).flatMap {browserOperations[$0]}
        guard let id,let op=engine.operations[id],!op.finished else {return}
        if event == "opening_ambiguous" || event == "opening_closed" {
            op.missing.insert(event);engine.finish(op,status:"unmeasured");return
        }
        if event == "mru_end" && data["status"] as? String != "switched" {op.missing.insert("no_tab_switch");engine.finish(op,status:"no_change");return}
        if let url=data["url"] as? String,!url.isEmpty {op.expectedURL=url}
        if let title=data["title"] as? String {op.expectedTitle=title}
        if data["created"] as? Bool == true,op.stages["browser_tab_created"] == nil {op.stages["browser_tab_created"]=at}
        if data["committed"] as? Bool == true,op.stages["browser_navigation_committed"] == nil {op.stages["browser_navigation_committed"]=at}
        if data["active"] as? Bool == true {
            op.targetConfirmed=true
            if op.stages["browser_target_active"] == nil {op.stages["browser_target_active"]=at}
        }
        if data["status"] as? String == "complete",op.stages["navigation_complete_observed"] == nil {op.stages["navigation_complete_observed"]=at}
        if event == "mru_end" {op.stages["action_completed"]=at}
        maybeFinishOpen(op)
    }
    func maybeFinishOpen(_ op:TimingOperation) {
        guard !op.finished,op.stages["target_ax_visible"] != nil,op.stages["action_completed"] != nil else {return}
        if op.resultKind == "opened" && op.stages["navigation_complete_observed"] == nil {
            if !op.firstUIRecorded {
                var record=op.record(status:op.key == nil ? "unmeasured" : "measured",end:"target_ax_visible")
                record["phase"]="first_visible";log.write(record);op.firstUIRecorded=true
            }
        } else {engine.finish(op,status:"measured",end:"target_ax_visible")}
    }
    func tick() {
        let now=timingNow(),locked=timingScreenLocked()
        if locked != previousLockState {previousLockState=locked;refreshPermissions()}
        if now-lastHealth>2_000_000_000 {refreshPermissions();engine.expire(now:now)}
        if locked {
            for op in engine.operations.values where !op.finished {
                if op.targetConfirmed,op.stages["target_ax_visible"] != nil {
                    engine.finish(op,status:"measured",end:"target_ax_visible")
                } else {
                    op.missing.insert("screen_locked");op.stages["screen_lock_observed"]=now
                    engine.finish(op,status:"suspended")
                }
            }
            return
        }
        if lastAlfred>0,now-lastAlfred>1_000_000_000,focusedApplication()?.bundleIdentifier != "com.runningwithcrayons.Alfred" {
            engine.cancelSearch();pendingEdits=[];lastInput=nil;lastAlfred=0
        }
        for op in engine.operations.values where op.kind == "copy" && !op.finished {
            if let count=op.clipboardBaseline,NSPasteboard.general.changeCount != count,
               NSPasteboard.general.string(forType:.string)==op.expectedURL {
                op.stages["clipboard_updated"]=now;engine.finish(op,status:"measured",end:"clipboard_updated")
            }
        }
        guard engine.accessibilityAllowed,!probeRunning else {return}
        let pending=engine.operations.values.contains { !$0.finished && $0.uiArmed }
        guard pending || !pendingEdits.isEmpty || engine.invocation != nil else {return}
        guard let app=focusedApplication(),let bundle=app.bundleIdentifier,
              ["com.runningwithcrayons.Alfred","com.google.Chrome"].contains(bundle) else {return}
        if bundle != "com.runningwithcrayons.Alfred" && !pending {return}
        if focusHistory.last?.1 != app.processIdentifier {
            focusHistory.append((now,app.processIdentifier,bundle));focusHistory=Array(focusHistory.suffix(16))
        }
        probeRunning=true;lastProbe=now
        let pid=app.processIdentifier
        DispatchQueue.global(qos:.userInitiated).async { [weak self] in
            let reading=UIProbe.read(pid:pid,bundle:bundle)
            DispatchQueue.main.async {self?.observed(reading)}
        }
    }
    func observed(_ reading:UIReading) {
        probeRunning=false;maxProbeMs=max(maxProbeMs,timingMS(reading.start,reading.end) ?? 0)
        lastProbeSummary=["application":reading.bundle,"onScreen":reading.onScreen,"inputAvailable":reading.input != nil,
                          "textElementCount":reading.strings.count,"documentAvailable":reading.document != nil,
                          "scanLimitReached":reading.exhausted,"durationMs":timingMS(reading.start,reading.end) ?? 0]
        guard focusedApplication()?.processIdentifier==reading.pid,reading.onScreen else {return}
        if reading.bundle == "com.runningwithcrayons.Alfred",let input=reading.input {
            lastAlfred=reading.end
            let expectations=engine.operations.values.filter {$0.kind == "search" && !$0.finished && !$0.rows.isEmpty}.map { op -> TimingObject in
                ["operation":op.id,"queryMatches":engine.queryMatches(input,op.query),"expectedRows":op.rows.count,
                 "matchedTitles":op.rows.filter { row in reading.strings.contains { timingText($0).contains(timingText(row["title"] ?? "\u{0}")) } }.count]
            }
            lastAlfredProbeSummary=lastProbeSummary
            lastAlfredProbeSummary["roles"]=reading.roleCounts
            lastAlfredProbeSummary["enhancedModeResult"]=reading.enhancedModeResult as Any? ?? NSNull()
            lastAlfredProbeSummary["expectations"]=expectations
            if input != lastInput {
                let candidates=pendingEdits.filter { $0.ns<=reading.start }
                engine.inputChanged(input,keys:candidates,observed:reading.end,sampleStarted:reading.start)
                pendingEdits.removeAll { $0.ns<=reading.start };lastInput=input
            }
            for op in engine.operations.values where op.kind == "search" && !op.finished && op.uiArmed {
                if engine.queryMatches(input,op.query),let written=op.stages["placeholder_written"],written<=reading.start,
                   op.stages["placeholder_ax_visible"] == nil,!op.placeholderRows.isEmpty,
                   op.placeholderRows.allSatisfy({ row in reading.strings.contains { $0.contains(row["title"] ?? "\u{0}") } }) {
                    op.stages["placeholder_ax_visible"]=reading.end
                }
                guard engine.queryMatches(input,op.query),let written=op.stages["output_written"],written<=reading.start,!op.rows.isEmpty else {continue}
                let matches=timingRowsVisible(op.rows,texts:reading.strings)
                if matches {
                    op.stages["results_ax_visible"]=reading.end;engine.finish(op,status:"measured",end:"results_ax_visible")
                } else if reading.strings.isEmpty {
                    op.missing.insert("alfred_results_not_exposed_to_accessibility")
                    if CGPreflightScreenCaptureAccess() {startPixelProbe(op,reading:reading)}
                    else {op.missing.insert("screen_capture_permission_for_result_pixels")}
                }
            }
        } else if reading.bundle == "com.google.Chrome" {
            for op in engine.operations.values where ["open","mru"].contains(op.kind) && !op.finished && op.targetConfirmed {
                guard let url=reading.document,!op.expectedURL.isEmpty,url==op.expectedURL,op.createdNs<=reading.start else {continue}
                if op.stages["target_ax_visible"] == nil {op.stages["target_ax_visible"]=reading.end}
                maybeFinishOpen(op)
            }
            if lastAlfred>0 && reading.end-lastAlfred>1_000_000_000 {engine.cancelSearch();pendingEdits=[];lastInput=nil;lastAlfred=0}
        }
    }
    func startPixelProbe(_ op:TimingOperation,reading:UIReading) {
        guard #available(macOS 14.0,*) else {lastPixelSummary=["error":"screen_capture_api_unavailable"];return}
        guard !pixelRunning,timingNow()-lastPixelStart>=80_000_000 else {return}
        guard let window=reading.windowFrame else {lastPixelSummary=["error":"window_frame_unavailable"];return}
        guard let input=reading.inputFrame else {lastPixelSummary=["error":"input_frame_unavailable"];return}
        pixelRunning=true;lastPixelStart=timingNow()
        let pid=reading.pid
        PixelProbe.capture(pid:pid,windowFrame:window,inputFrame:input,query:op.query,rows:op.rows,
            foreground:{[weak self] in !timingScreenLocked() && self?.focusedApplication()?.processIdentifier==pid}) { [weak self] pixels in
            DispatchQueue.main.async {
                guard let self else {return};self.pixelRunning=false
                self.lastPixelSummary=["queryMatched":pixels.queryMatches,"rowsMatched":pixels.rowsMatch,
                    "observedTextLines":pixels.observedLines,"matchedTitles":pixels.matchedTitles,
                    "captureMs":timingMS(pixels.captureStarted,pixels.captured) as Any? ?? NSNull(),
                    "recognitionMs":timingMS(pixels.captured,pixels.recognized) as Any? ?? NSNull(),
                    "error":pixels.error as Any? ?? NSNull(),"windowID":pixels.windowID]
                guard pixels.error == nil,pixels.queryMatches,pixels.rowsMatch else {return}
                if op.finished {
                    let beforeSuperseding=op.missing.contains("superseded_by_new_input") && pixels.captured <= (op.stages["superseded_at"] ?? 0)
                    let beforeLock=op.missing.contains("screen_locked") && pixels.captured <= (op.stages["screen_lock_observed"] ?? 0)
                    guard beforeSuperseding || beforeLock else {return}
                    op.finished=false;op.missing.remove("superseded_by_new_input")
                }
                op.missing.remove("alfred_results_not_exposed_to_accessibility")
                op.missing.remove("screen_capture_permission_for_result_pixels")
                op.missing.remove("screen_locked")
                op.stages["results_pixels_capture_started"]=pixels.captureStarted
                op.stages["results_pixels_visible"]=pixels.captured
                op.stages["results_pixels_recognized"]=pixels.recognized
                self.engine.finish(op,status:"measured",end:"results_pixels_visible")
            }
        }
    }
    func applicationWillTerminate(_ notification:Notification) {
        unlink(cache.appendingPathComponent("timing.sock").path)
        try? FileManager.default.removeItem(at:cache.appendingPathComponent("timing-health.json"))
    }
}

@main struct DiagnosticsMain {
    static func main() {
        let cache=NSHomeDirectory()+"/Library/Caches/BookmarkWorkspaces"
        try? FileManager.default.createDirectory(atPath:cache,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let lock=open(cache+"/timing.lock",O_CREAT|O_RDWR,0o600)
        guard lock>=0,flock(lock,LOCK_EX|LOCK_NB)==0 else {return}
        let app=NSApplication.shared,collector=Collector();app.setActivationPolicy(.accessory);app.delegate=collector
        withExtendedLifetime(collector) {app.run()};close(lock)
    }
}
