import Foundation
import Darwin

@_silgen_name("chrome_timing_exchange_tracked")
private func bridgeExchange(_ path: UnsafePointer<CChar>, _ message: UnsafePointer<CChar>, _ reply: UnsafeMutablePointer<CChar>, _ capacity: Int32, _ timeout: Int32, _ dispatched: UnsafeMutablePointer<Int32>) -> Int32

struct SwitcherConfiguration: Codable {
    let profile: String
    let cacheFolder: String
    static func load() -> SwitcherConfiguration {
        if let url=Bundle.main.url(forResource:"config",withExtension:"json"),
           let data=try? Data(contentsOf:url), let value=try? JSONDecoder().decode(Self.self,from:data) { return value }
        return Self(profile:"Default",cacheFolder:"BookmarkWorkspaces")
    }
    var directory: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches").appendingPathComponent(cacheFolder) }
}

final class PreviewClient {
    let config: SwitcherConfiguration
    let queue=DispatchQueue(label:"tab-switcher.bridge",qos:.userInitiated)
    init(_ config: SwitcherConfiguration) { self.config=config }
    func request(_ endpoint:String,body:[String:Any]?=nil) -> Data? {
        let data=body.flatMap {try? JSONSerialization.data(withJSONObject:$0)} ?? Data()
        let wire="\(body == nil ? "GET" : "POST") \(endpoint) HTTP/1.0\r\nHost: localhost\r\nX-Chrome-Profile: \(config.profile)\r\nX-Chrome-Expires: \(Int(Date().timeIntervalSince1970*1000)+700)\r\nContent-Type: application/json\r\nContent-Length: \(data.count)\r\n\r\n"+(String(data:data,encoding:.utf8) ?? "")
        var buffer=[CChar](repeating:0,count:1_048_576),dispatched:Int32=0
        let count=config.directory.appendingPathComponent("native.sock").path.withCString { path in
            wire.withCString { bridgeExchange(path,$0,&buffer,Int32(buffer.count),900,&dispatched) }
        }
        guard count>0 else { return nil }
        let bytes=buffer.withUnsafeBytes {Data($0.prefix(Int(count)))}
        guard let boundary=bytes.range(of:Data("\r\n\r\n".utf8)),
              let header=String(data:bytes[..<boundary.lowerBound],encoding:.utf8),header.split(separator:" ").dropFirst().first=="200" else { return nil }
        return Data(bytes[boundary.upperBound...])
    }
    func recent(_ completion:@escaping(PreviewSnapshot?)->Void) {
        queue.async {
            let value=self.request("/tabs/recent").flatMap {try? JSONDecoder().decode(PreviewSnapshot.self,from:$0)}
            DispatchQueue.main.async {completion(value?.valid == true ? value : nil)}
        }
    }
    func focus(_ selection:PreviewSelection,completion:@escaping(Bool)->Void) {
        queue.async {
            let tab=selection.tab
            let body:[String:Any] = ["version":1,"tabId":tab.id,"windowId":tab.windowId,"originTabId":selection.originTabId,"url":tab.url]
            let response=self.request("/tabs/focus",body:body).flatMap {try? JSONSerialization.jsonObject(with:$0) as? [String:Any]}
            let success=response?["kind"] as? String == "focused" && response?["tabId"] as? String == String(tab.id)
            DispatchQueue.main.async {completion(success)}
        }
    }
}

// Wake-up messages contain no titles, URLs or images. The socket is user-only.
final class PreviewNotifications {
    private var fd:Int32 = -1
    func start(directory:URL,changed:@escaping()->Void) {
        let path=directory.appendingPathComponent("tab-switcher.sock").path
        try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        unlink(path);fd=socket(AF_UNIX,SOCK_STREAM,0)
        guard fd>=0 else {return}
        var address=sockaddr_un();address.sun_family=sa_family_t(AF_UNIX)
        let capacity=MemoryLayout.size(ofValue:address.sun_path)
        guard path.utf8.count < capacity else {return}
        withUnsafeMutablePointer(to:&address.sun_path) {ptr in ptr.withMemoryRebound(to:CChar.self,capacity:capacity) { _=strlcpy($0,path,capacity) }}
        let result=withUnsafePointer(to:&address) {ptr in ptr.withMemoryRebound(to:sockaddr.self,capacity:1) {Darwin.bind(fd,$0,socklen_t(MemoryLayout<sockaddr_un>.size))}}
        guard result==0 else {close(fd);return};chmod(path,0o600);listen(fd,8)
        DispatchQueue.global(qos:.utility).async { [self] in
            while true {
                let client=accept(fd,nil,nil);if client<0 {break}
                var timeout=timeval(tv_sec:0,tv_usec:100000);setsockopt(client,SOL_SOCKET,SO_RCVTIMEO,&timeout,socklen_t(MemoryLayout<timeval>.size))
                var bytes=[UInt8](repeating:0,count:256);let count=read(client,&bytes,bytes.count);close(client)
                if count>0, let object=(try? JSONSerialization.jsonObject(with:Data(bytes.prefix(count)))) as? [String:Any],object["type"] as? String == "changed" {
                    DispatchQueue.main.async {changed()}
                }
            }
        }
    }
}
