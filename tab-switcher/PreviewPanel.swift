import AppKit

final class PreviewPanel: NSPanel {
    override var canBecomeKey:Bool { false }
    override var canBecomeMain:Bool { false }
    private let surface=NSVisualEffectView()
    private let stack=NSStackView()
    private let heading=NSTextField(labelWithString:"最近标签")
    private let footer=NSTextField(labelWithString:"")
    var choose:((Int)->Void)?
    private var actions:[CardAction]=[]
    init() {
        super.init(contentRect:NSRect(x:0,y:0,width:870,height:268),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        level = .floating;isOpaque=false;backgroundColor = .clear;hasShadow=true;hidesOnDeactivate=false
        collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary,.transient,.ignoresCycle]
        surface.material = .hudWindow;surface.blendingMode = .behindWindow;surface.state = .active
        surface.wantsLayer=true;surface.layer?.cornerRadius=22;surface.layer?.masksToBounds=true
        contentView=surface
        heading.font = .systemFont(ofSize:15,weight:.semibold)
        footer.font = .systemFont(ofSize:11);footer.textColor = .secondaryLabelColor
        stack.orientation = .horizontal;stack.spacing=10;stack.distribution = .fillEqually
        for view in [heading,stack,footer] {surface.addSubview(view);view.translatesAutoresizingMaskIntoConstraints=false}
        NSLayoutConstraint.activate([
            heading.leadingAnchor.constraint(equalTo:surface.leadingAnchor,constant:22),heading.topAnchor.constraint(equalTo:surface.topAnchor,constant:18),
            stack.leadingAnchor.constraint(equalTo:surface.leadingAnchor,constant:16),stack.trailingAnchor.constraint(equalTo:surface.trailingAnchor,constant:-16),
            stack.topAnchor.constraint(equalTo:heading.bottomAnchor,constant:15),stack.heightAnchor.constraint(equalToConstant:170),
            footer.centerXAnchor.constraint(equalTo:surface.centerXAnchor),footer.topAnchor.constraint(equalTo:stack.bottomAnchor,constant:13)
        ])
    }
    func render(snapshot:PreviewSnapshot,index:Int,images:[String:NSImage],show:Bool) {
        stack.arrangedSubviews.forEach {stack.removeArrangedSubview($0);$0.removeFromSuperview()};actions=[]
        let count=min(snapshot.tabs.count,5)
        let start=max(0,min(index-2,snapshot.tabs.count-count))
        for offset in start..<(start+count) {
            let tab=snapshot.tabs[offset],selected=offset==index
            let card=NSView();card.wantsLayer=true;card.layer?.cornerRadius=13
            card.widthAnchor.constraint(equalToConstant:164).isActive=true
            card.layer?.backgroundColor=selected ? NSColor.controlAccentColor.withAlphaComponent(0.16).cgColor : NSColor.controlBackgroundColor.withAlphaComponent(0.18).cgColor
            card.layer?.borderWidth=selected ? 2.5 : 0.5
            card.layer?.borderColor=(selected ? NSColor.controlAccentColor : NSColor.separatorColor.withAlphaComponent(0.4)).cgColor
            let picture=NSImageView();picture.imageScaling = .scaleProportionallyUpOrDown
            picture.setContentCompressionResistancePriority(.defaultLow,for:.horizontal)
            picture.wantsLayer=true;picture.layer?.cornerRadius=8;picture.layer?.masksToBounds=true
            picture.layer?.backgroundColor=NSColor.black.withAlphaComponent(0.10).cgColor
            if let image=images[tab.cacheKey] {picture.image=image}
            else {picture.image=NSImage(systemSymbolName:"globe",accessibilityDescription:nil);picture.contentTintColor = .tertiaryLabelColor}
            let title=NSTextField(labelWithString:tab.label);title.font = .systemFont(ofSize:12,weight:selected ? .semibold : .medium)
            title.maximumNumberOfLines=1;title.lineBreakMode = .byTruncatingTail;title.toolTip=tab.label
            let detail=NSTextField(labelWithString:images[tab.cacheKey] == nil ? "\(tab.domain) · 待预览" : tab.domain)
            detail.font = .systemFont(ofSize:10);detail.textColor = .secondaryLabelColor;detail.lineBreakMode = .byTruncatingMiddle
            title.setContentCompressionResistancePriority(.defaultLow,for:.horizontal)
            detail.setContentCompressionResistancePriority(.defaultLow,for:.horizontal)
            for view in [picture,title,detail] {card.addSubview(view);view.translatesAutoresizingMaskIntoConstraints=false}
            NSLayoutConstraint.activate([
                picture.leadingAnchor.constraint(equalTo:card.leadingAnchor,constant:8),picture.trailingAnchor.constraint(equalTo:card.trailingAnchor,constant:-8),picture.topAnchor.constraint(equalTo:card.topAnchor,constant:8),picture.heightAnchor.constraint(equalToConstant:112),
                title.leadingAnchor.constraint(equalTo:card.leadingAnchor,constant:10),title.trailingAnchor.constraint(equalTo:card.trailingAnchor,constant:-10),title.topAnchor.constraint(equalTo:picture.bottomAnchor,constant:8),
                detail.leadingAnchor.constraint(equalTo:title.leadingAnchor),detail.trailingAnchor.constraint(equalTo:title.trailingAnchor),detail.topAnchor.constraint(equalTo:title.bottomAnchor,constant:3)
            ])
            let action=CardAction { [weak self] in self?.choose?(offset) };actions.append(action)
            card.addGestureRecognizer(NSClickGestureRecognizer(target:action,action:#selector(CardAction.clicked)))
            stack.addArrangedSubview(card)
        }
        footer.stringValue="\(index+1) / \(snapshot.tabs.count)    ⌃ 保持预览  ·  Tab 下一页  ·  ⇧Tab 上一页  ·  Esc 取消"
        let width=CGFloat(count)*164+CGFloat(count-1)*10+32
        setContentSize(NSSize(width:width,height:268))
        if show {
            let mouse=NSEvent.mouseLocation
            let screen=NSScreen.screens.first {NSMouseInRect(mouse,$0.frame,false)} ?? NSScreen.main
            if let area=screen?.visibleFrame {setFrameOrigin(NSPoint(x:area.midX-width/2,y:area.midY-134))}
            orderFrontRegardless()
        }
    }
    func renderDemo(to path:String) {
        let tabs=(1...5).map {PreviewTab(id:$0,windowId:1,title:["Design notes","Project board","Documentation","Inbox","Weekend plans"][$0-1],url:"https://example.test/\($0)",loading:false,active:$0==1,groupId:-1)}
        var images:[String:NSImage]=[:]
        for (i,tab) in tabs.enumerated() {
            let image=NSImage(size:NSSize(width:400,height:240));image.lockFocus()
            NSColor(calibratedHue:CGFloat(i)*0.16+0.05,saturation:0.18,brightness:0.94,alpha:1).setFill();NSRect(x:0,y:0,width:400,height:240).fill()
            NSColor.white.withAlphaComponent(0.7).setFill()
            NSBezierPath(roundedRect:NSRect(x:22,y:110,width:356,height:100),xRadius:8,yRadius:8).fill()
            for row in 0..<3 {NSBezierPath(roundedRect:NSRect(x:22,y:CGFloat(20+row*25),width:CGFloat(300-row*40),height:12),xRadius:4,yRadius:4).fill()}
            image.unlockFocus();images[tab.cacheKey]=image
        }
        render(snapshot:PreviewSnapshot(kind:"recent_tabs",windowId:1,activeTabId:1,tabs:tabs),index:1,images:images,show:false)
        surface.layoutSubtreeIfNeeded()
        guard let bitmap=surface.bitmapImageRepForCachingDisplay(in:surface.bounds) else {return}
        surface.cacheDisplay(in:surface.bounds,to:bitmap)
        try? bitmap.representation(using:.png,properties:[:])?.write(to:URL(fileURLWithPath:path))
    }
}

private final class CardAction:NSObject {
    let action:()->Void
    init(_ action:@escaping()->Void) {self.action=action}
    @objc func clicked() {action()}
}
