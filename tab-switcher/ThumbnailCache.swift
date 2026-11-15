import AppKit
import ScreenCaptureKit
import ApplicationServices

private enum ChromeViewport {
    static func attribute(_ element:AXUIElement,_ key:String)->CFTypeRef? {
        var value:CFTypeRef?;return AXUIElementCopyAttributeValue(element,key as CFString,&value) == .success ? value : nil
    }
    static func element(_ value:CFTypeRef?)->AXUIElement? {
        guard let value,CFGetTypeID(value)==AXUIElementGetTypeID() else {return nil};return (value as! AXUIElement)
    }
    static func frame(_ element:AXUIElement)->CGRect? {
        guard let p=attribute(element,kAXPositionAttribute),let s=attribute(element,kAXSizeAttribute),
              CFGetTypeID(p)==AXValueGetTypeID(),CFGetTypeID(s)==AXValueGetTypeID() else {return nil}
        var point=CGPoint.zero,size=CGSize.zero
        guard AXValueGetValue(p as! AXValue,.cgPoint,&point),AXValueGetValue(s as! AXValue,.cgSize,&size) else {return nil}
        return CGRect(origin:point,size:size)
    }
    static func read(pid:pid_t,tab:PreviewTab,bounds:PreviewBounds)->CGRect? {
        let app=AXUIElementCreateApplication(pid);AXUIElementSetMessagingTimeout(app,0.04)
        guard let window=element(attribute(app,kAXFocusedWindowAttribute)),let rect=frame(window),
              abs(rect.minX-bounds.left)<8,abs(rect.minY-bounds.top)<8,
              abs(rect.width-bounds.width)<8,abs(rect.height-bounds.height)<8 else {return nil}
        func webFrame(_ node:AXUIElement)->CGRect? {
            guard attribute(node,kAXRoleAttribute) as? String == "AXWebArea" else {return nil}
            let value=attribute(node,kAXURLAttribute)
            let url=(value as? URL)?.absoluteString ?? value as? String
            guard url==tab.url,let frame=frame(node),frame.width>100,frame.height>80 else {return nil}
            return frame.intersection(rect)
        }
        var focused=element(attribute(app,kAXFocusedUIElementAttribute))
        for _ in 0..<10 {
            guard let node=focused else {break};if let frame=webFrame(node) {return frame}
            focused=element(attribute(node,kAXParentAttribute))
        }
        var queue:[AXUIElement]=[window],position=0
        while position<queue.count && position<80 {
            let node=queue[position];position += 1
            if let frame=webFrame(node) {return frame}
            if attribute(node,kAXRoleAttribute) as? String == "AXWebArea" {continue}
            if let children=attribute(node,kAXChildrenAttribute) as? [AXUIElement] {queue.append(contentsOf:children.prefix(80-queue.count))}
        }
        return nil
    }
}

@MainActor final class ThumbnailCache {
    private(set) var images:[String:NSImage]=[:]
    private var order:[String]=[]
    private var generation=0
    private(set) var captureState="waiting_for_page"
    func invalidate() {generation += 1}
    func retain(_ snapshot:PreviewSnapshot) {
        let valid=Set(snapshot.tabs.map(\.cacheKey))
        images=images.filter {valid.contains($0.key)};order=order.filter {valid.contains($0)}
    }
    func capture(_ tab:PreviewTab,pid:pid_t,bounds:PreviewBounds?,validate:@escaping(@escaping(Bool)->Void)->Void) {
        generation += 1;let ticket=generation
        guard !tab.loading,CGPreflightScreenCaptureAccess(),let bounds else {captureState="waiting_for_page";return}
        // Capture only the visible Chrome window, never activate a background tab.
        let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        guard let number=windows.first(where:{item in
            guard (item[kCGWindowOwnerPID as String] as? Int)==Int(pid),(item[kCGWindowLayer as String] as? Int)==0,
                  let raw=item[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:raw as CFDictionary) else {return false}
            return abs(rect.minX-bounds.left)<8 && abs(rect.minY-bounds.top)<8 && abs(rect.width-bounds.width)<8 && abs(rect.height-bounds.height)<8
        })?[kCGWindowNumber as String] as? UInt32 else {captureState="window_unverified";return}
        Task { @MainActor [self] in
            do {
                var viewport=await Task.detached(priority:.utility) {ChromeViewport.read(pid:pid,tab:tab,bounds:bounds)}.value
                if viewport == nil {
                    try await Task.sleep(nanoseconds:450_000_000)
                    guard ticket==generation else {return}
                    viewport=await Task.detached(priority:.utility) {ChromeViewport.read(pid:pid,tab:tab,bounds:bounds)}.value
                }
                guard let viewport,ticket==generation else {captureState="page_unverified";return}
                try await Task.sleep(nanoseconds:150_000_000)
                let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
                guard ticket==generation,let window=content.windows.first(where:{$0.windowID==number && $0.owningApplication?.processID==pid}) else {return}
                let config=SCStreamConfiguration()
                let scale=min(640/max(1,window.frame.width),400/max(1,window.frame.height))
                config.width=max(1,Int(window.frame.width*scale));config.height=max(1,Int(window.frame.height*scale))
                config.showsCursor=false;config.capturesAudio=false
                if #available(macOS 14.2,*) {config.ignoreShadowsSingleWindow=true}
                let image=try await SCScreenshotManager.captureImage(contentFilter:SCContentFilter(desktopIndependentWindow:window),configuration:config)
                guard ticket==generation else {return}
                let crop=CGRect(x:(viewport.minX-window.frame.minX)*CGFloat(image.width)/window.frame.width,
                    y:(viewport.minY-window.frame.minY)*CGFloat(image.height)/window.frame.height,
                    width:viewport.width*CGFloat(image.width)/window.frame.width,height:viewport.height*CGFloat(image.height)/window.frame.height)
                    .intersection(CGRect(x:0,y:0,width:image.width,height:image.height))
                guard crop.width>40,crop.height>40,let webpage=image.cropping(to:crop) else {captureState="page_unverified";return}
                validate { [weak self] valid in
                    guard let self,valid,ticket==self.generation else {return}
                    self.images[tab.cacheKey]=NSImage(cgImage:webpage,size:.zero);self.captureState="webpage_cached"
                    self.order.removeAll {$0==tab.cacheKey};self.order.append(tab.cacheKey)
                    while self.order.count>20 {self.images.removeValue(forKey:self.order.removeFirst())}
                }
            } catch {if ticket==generation {captureState="capture_unavailable"}}
        }
    }
}
