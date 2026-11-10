import AppKit

@main struct PixelProbeTests {
    static func main() throws {
        guard #available(macOS 14.0,*) else {return}
        let image=NSImage(size:NSSize(width:640,height:200))
        image.lockFocus();NSColor.white.setFill();NSRect(x:0,y:0,width:640,height:200).fill()
        let attributes:[NSAttributedString.Key:Any]=[.font:NSFont.systemFont(ofSize:30),.foregroundColor:NSColor.black]
        ("Example Bookmark" as NSString).draw(at:NSPoint(x:24,y:125),withAttributes:attributes)
        ("⌘1" as NSString).draw(at:NSPoint(x:590,y:125),withAttributes:[.font:NSFont.systemFont(ofSize:17),.foregroundColor:NSColor.black])
        ("example" as NSString).draw(at:NSPoint(x:24,y:55),withAttributes:attributes)
        image.unlockFocus()
        var rect=NSRect(origin:.zero,size:image.size)
        let pixels=image.cgImage(forProposedRect:&rect,context:nil,hints:nil)!
        let recognized=try PixelProbe.recognize(pixels)
        let candidates=try PixelProbe.candidates(pixels)
        precondition(candidates.contains {PixelProbe.matches($0,title:"Example Bookmark")},"Rendered title must be recognized separately from a right-aligned shortcut badge")
        precondition(!pixelRowsMatch([["title":"Unrelated Bookmark"]],recognized),"Unrelated pixels cannot confirm a result")
        precondition(!pixelRowsMatch([["title":"example"],["title":"example"]],["example"]),"Duplicate titles need distinct visible occurrences")
        precondition(!pixelRowsMatch([["title":"example"]],[]),"No visible text means no completion")
        print("4 pixel-recognition assertions passed; no screen or user content captured")
    }
}
