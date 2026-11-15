import AppKit
import ApplicationServices
import Darwin

final class SwitcherKeyboard {
    private(set) var port:CFMachPort?
    private var source:CFRunLoopSource?
    var handle:((CGEventType,CGEvent)->Bool)?
    var gap:(()->Void)?
    func start() {
        guard port==nil else {return}
        let mask=[CGEventType.keyDown,.keyUp,.flagsChanged].reduce(CGEventMask(0)) {$0 | (1 << $1.rawValue)}
        port=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.defaultTap,eventsOfInterest:mask,callback:{_,type,event,pointer in
            guard let pointer else {return Unmanaged.passUnretained(event)}
            let owner=Unmanaged<SwitcherKeyboard>.fromOpaque(pointer).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                owner.gap?();if let port=owner.port {CGEvent.tapEnable(tap:port,enable:true)}
            } else if owner.handle?(type,event)==true {return nil}
            return Unmanaged.passUnretained(event)
        },userInfo:Unmanaged.passUnretained(self).toOpaque())
        guard let port else {return}
        source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,port,0)
        CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes);CGEvent.tapEnable(tap:port,enable:true)
    }
}

@MainActor final class SwitcherApp:NSObject,NSApplicationDelegate {
    let config=SwitcherConfiguration.load()
    lazy var client=PreviewClient(config)
    let keyboard=SwitcherKeyboard(),notifications=PreviewNotifications(),thumbnails=ThumbnailCache()
    let panel=PreviewPanel()
    var core=SwitcherCore()
    var statusItem:NSStatusItem?
    var statusLine:NSMenuItem?
    var enabled=true,chromeFront=false,bridgeReady=false,previewDelayElapsed=false
    var chromePID:pid_t=0
    var suppressed=Set<Int>()
    var refreshTask:DispatchWorkItem?
    var refreshGeneration=0
    var gesturesStarted=0,completed=0,cancelled=0
    var previewsShown=0
    var lastFocusSucceeded:Bool?
    var lockFD:Int32 = -1

    func applicationDidFinishLaunching(_ notification:Notification) {
        try? FileManager.default.createDirectory(at:config.directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        lockFD=open(config.directory.appendingPathComponent("tab-switcher.lock").path,O_CREAT|O_RDWR,0o600)
        guard lockFD>=0,flock(lockFD,LOCK_EX|LOCK_NB)==0 else {NSApp.terminate(nil);return}
        NSApp.setActivationPolicy(.accessory)
        UserDefaults.standard.register(defaults:["enabled":true]);enabled=UserDefaults.standard.bool(forKey:"enabled")
        makeMenu()
        panel.choose={ [weak self] index in guard let self else {return};self.core.choose(index);self.finish() }
        keyboard.handle={ [weak self] type,event in self?.key(type,event) ?? false }
        keyboard.gap={ [weak self] in self?.cancel() }
        NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { [weak self] _ in
            MainActor.assumeIsolated {self?.updateFrontmost()}
        }
        notifications.start(directory:config.directory) { [weak self] in self?.scheduleRefresh() }
        updateFrontmost();refreshPermissions()
        Timer.scheduledTimer(withTimeInterval:3,repeats:true) { [weak self] _ in MainActor.assumeIsolated {self?.refreshPermissions()} }
        if CommandLine.arguments.contains("--request-permissions") {requestPermissions()}
    }

    func makeMenu() {
        statusItem=NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength)
        statusItem?.button?.image=NSImage(systemSymbolName:"rectangle.on.rectangle",accessibilityDescription:"Chrome Tab Switcher")
        let menu=NSMenu();let line=NSMenuItem(title:"Chrome · ⌃Tab",action:nil,keyEquivalent:"");statusLine=line;menu.addItem(line)
        menu.addItem(.separator())
        let toggle=NSMenuItem(title:"启用 Chrome 标签预览",action:#selector(toggleEnabled(_:)),keyEquivalent:"");toggle.target=self;toggle.state = enabled ? .on : .off;menu.addItem(toggle)
        let permissions=NSMenuItem(title:"授权所需权限…",action:#selector(requestPermissions),keyEquivalent:"");permissions.target=self;menu.addItem(permissions)
        menu.addItem(.separator())
        let quit=NSMenuItem(title:"退出",action:#selector(quitApp),keyEquivalent:"");quit.target=self;menu.addItem(quit)
        statusItem?.menu=menu
    }
    @objc func toggleEnabled(_ sender:NSMenuItem) {enabled.toggle();UserDefaults.standard.set(enabled,forKey:"enabled");sender.state=enabled ? .on : .off;if !enabled {cancel()};writeHealth()}
    @objc func quitApp() {NSApp.terminate(nil)}
    @objc func requestPermissions() {
        _=AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
        if !CGPreflightListenEventAccess() {_=CGRequestListenEventAccess()}
        if !CGPreflightScreenCaptureAccess() {_=CGRequestScreenCaptureAccess()}
        refreshPermissions()
    }
    func refreshPermissions() {
        if AXIsProcessTrusted() {keyboard.start()}
        statusLine?.title=keyboard.port == nil ? "⌃Tab · 等待辅助功能授权" : "Chrome · ⌃Tab"
        writeHealth()
    }
    func updateFrontmost() {
        let front=NSWorkspace.shared.frontmostApplication
        chromeFront=front?.bundleIdentifier=="com.google.Chrome";chromePID=chromeFront ? front!.processIdentifier : 0
        if !chromeFront {cancel();thumbnails.invalidate();refreshGeneration += 1}
        else {scheduleRefresh()}
        writeHealth()
    }
    func key(_ type:CGEventType,_ event:CGEvent)->Bool {
        let code=Int(event.getIntegerValueField(.keyboardEventKeycode))
        if type == .keyUp {return suppressed.remove(code) != nil}
        let control=event.flags.contains(.maskControl),shift=event.flags.contains(.maskShift)
        let other=event.flags.contains(.maskCommand) || event.flags.contains(.maskAlternate)
        if type == .flagsChanged {
            if core.holding && (!chromeFront || !enabled || other) {cancel()}
            else if core.holding && !control {finish()}
            return false
        }
        guard type == .keyDown else {return false}
        guard enabled && chromeFront else {if core.holding {cancel()};return false}
        if code==48 && control && !other {
            suppressed.insert(code)
            if core.holding && !core.released {core.move(reverse:shift);render()}
            else {begin(reverse:shift)}
            return true
        }
        if core.holding && !core.released {
            if code==53 {suppressed.insert(code);cancel();return true}
            if control && !other && [123,124].contains(code) {suppressed.insert(code);core.move(reverse:code==123);render();return true}
            if code==36 {suppressed.insert(code);finish();return true}
            cancel()
        }
        return false
    }
    func begin(reverse:Bool) {
        let token=core.begin(reverse:reverse);gesturesStarted += 1;previewDelayElapsed=false
        refreshTask?.cancel();refreshGeneration += 1;thumbnails.invalidate()
        client.recent { [weak self] snapshot in
            guard let self,self.core.token==token,self.core.holding else {return}
            guard self.chromeFront,let snapshot else {self.bridgeReady=false;self.cancel();return}
            self.bridgeReady=true
            if let selection=self.core.load(snapshot,token:token) {self.commit(selection)}
            else {self.render()}
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+0.18) { [weak self] in
            guard let self,self.core.token==token,self.core.holding,!self.core.released else {return}
            self.previewDelayElapsed=true;self.render()
        }
    }
    func render() {
        guard core.canPreview,let snapshot=core.snapshot else {return}
        if previewDelayElapsed && !panel.isVisible {previewsShown += 1}
        panel.render(snapshot:snapshot,index:core.selectedIndex,images:thumbnails.images,show:previewDelayElapsed)
    }
    func finish() {
        panel.orderOut(nil)
        if let selection=core.release() {commit(selection)}
        else if !core.holding {scheduleRefresh()}
    }
    func commit(_ selection:PreviewSelection) {
        panel.orderOut(nil)
        guard chromeFront else {cancel();return}
        client.focus(selection) { [weak self] success in
            guard let self else {return}
            self.lastFocusSucceeded=success;if success {self.completed += 1}
            self.writeHealth();self.scheduleRefresh()
        }
    }
    func cancel() {
        if core.holding {cancelled += 1}
        core.cancel();panel.orderOut(nil);previewDelayElapsed=false
    }
    func scheduleRefresh() {
        guard chromeFront,enabled,!core.holding else {return}
        refreshTask?.cancel();thumbnails.invalidate();refreshGeneration += 1;let ticket=refreshGeneration
        let work=DispatchWorkItem { [weak self] in
            guard let self,self.chromeFront,!self.core.holding,self.refreshGeneration==ticket else {return}
            self.client.recent { [weak self] snapshot in
                guard let self,self.refreshGeneration==ticket,self.chromeFront,!self.core.holding else {return}
                self.bridgeReady=snapshot != nil
                guard let snapshot,let tab=snapshot.tabs.first else {self.writeHealth();return}
                self.thumbnails.retain(snapshot)
                self.thumbnails.capture(tab,pid:self.chromePID,bounds:snapshot.bounds) { [weak self] completion in
                    guard let self else {completion(false);return}
                    self.client.recent {latest in
                        completion(self.chromeFront && !self.core.holding && latest?.activeTabId==tab.id && latest?.tabs.first?.url==tab.url)
                        self.writeHealth()
                    }
                }
                self.writeHealth()
            }
        }
        refreshTask=work;DispatchQueue.main.asyncAfter(deadline:.now()+0.45,execute:work)
    }
    func writeHealth() {
        let state:[String:Any]=["version":1,"pid":getpid(),"accessibility":AXIsProcessTrusted(),"inputMonitoring":CGPreflightListenEventAccess(),
            "screenCapture":CGPreflightScreenCaptureAccess(),"eventTapRunning":keyboard.port != nil,"enabled":enabled,
            "chromeFront":chromeFront,"bridgeReady":bridgeReady,"gesturesStarted":gesturesStarted,"completed":completed,"cancelled":cancelled,
            "cachedPreviews":thumbnails.images.count,"captureState":thumbnails.captureState,"previewsShown":previewsShown,
            "shortcut":"Control+Tab","lastFocusSucceeded":lastFocusSucceeded as Any? ?? NSNull()]
        if let data=try? JSONSerialization.data(withJSONObject:state,options:[.sortedKeys]) {
            let path=config.directory.appendingPathComponent("tab-switcher-health.json")
            try? data.write(to:path,options:.atomic);try? FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path)
        }
    }
}

@main @MainActor struct TabSwitcherMain {
    static func main() {
        let app=NSApplication.shared
        if let i=CommandLine.arguments.firstIndex(of:"--render-demo"),CommandLine.arguments.count>i+1 {
            app.setActivationPolicy(.prohibited);PreviewPanel().renderDemo(to:CommandLine.arguments[i+1]);return
        }
        let delegate=SwitcherApp();app.delegate=delegate;withExtendedLifetime(delegate) {app.run()}
    }
}
