import Foundation
import AppKit
import ScreenCaptureKit
import Vision

struct PixelReading {
    var captureStarted:UInt64=0,captured:UInt64=0,recognized:UInt64=0
    var queryMatches=false,rowsMatch=false
    var error:String?
    var windowID:UInt32=0
    var observedLines=0,matchedTitles=0
}
func pixelText(_ value:String)->String {
    timingText(value).lowercased().filter {!$0.isWhitespace}
}
func pixelRowsMatch(_ expected:[[String:String]],_ observed:[String])->Bool {
    let values=observed.map(pixelText)
    let titles=expected.map {pixelText($0["title"] ?? "")}
    guard !titles.isEmpty,titles.allSatisfy({!$0.isEmpty}) else {return false}
    for title in Set(titles) {
        guard values.filter({$0==title}).count >= titles.filter({$0==title}).count else {return false}
    }
    return true
}
@available(macOS 14.0, *)
enum PixelProbe {
    static func candidates(_ image:CGImage) throws->[VNRecognizedText] {
        let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate
        request.usesLanguageCorrection=false;request.recognitionLanguages=["en-US","zh-Hans"]
        try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
        return request.results?.compactMap {$0.topCandidates(1).first} ?? []
    }
    static func recognize(_ image:CGImage) throws->[String] {
        try candidates(image).map(\.string)
    }
    static func matches(_ candidate:VNRecognizedText,title:String)->Bool {
        let text=candidate.string,wanted=pixelText(title)
        if pixelText(text)==wanted {return true}
        guard !wanted.isEmpty else {return false}
        var normalized="",starts:[String.Index]=[],ends:[String.Index]=[]
        for index in text.indices {
            let end=text.index(after:index)
            for c in pixelText(String(text[index..<end])) {normalized.append(c);starts.append(index);ends.append(end)}
        }
        guard let range=normalized.range(of:wanted) else {return false}
        let start=normalized.distance(from:normalized.startIndex,to:range.lowerBound)
        let end=normalized.distance(from:normalized.startIndex,to:range.upperBound)-1
        let original=starts[start]..<ends[end]
        guard let titleBox=try? candidate.boundingBox(for:original)?.boundingBox else {return false}
        let prefix=text.startIndex..<original.lowerBound,suffix=original.upperBound..<text.endIndex
        if !pixelText(String(text[prefix])).isEmpty {
            guard pixelText(String(text[prefix])).count<=2,let box=try? candidate.boundingBox(for:prefix)?.boundingBox,
                  box.maxX<0.09,titleBox.minX-box.maxX>0.015 else {return false}
        }
        if !pixelText(String(text[suffix])).isEmpty {
            guard pixelText(String(text[suffix])).count<=3,let box=try? candidate.boundingBox(for:suffix)?.boundingBox,
                  box.minX>0.87,box.minX-titleBox.maxX>0.04 else {return false}
        }
        return true
    }
    static func joinedLines(_ candidates:[VNRecognizedText])->[String] {
        let parts=candidates.compactMap {c -> (String,CGRect)? in
            guard let box=try? c.boundingBox(for:c.string.startIndex..<c.string.endIndex)?.boundingBox else {return nil}
            return (c.string,box)
        }.sorted {$0.1.midY>$1.1.midY}
        var groups:[[(String,CGRect)]]=[]
        for part in parts {
            if let index=groups.firstIndex(where:{ group in
                guard let first=group.first else {return false}
                return abs(first.1.midY-part.1.midY)<max(first.1.height,part.1.height)*0.45
            }) {groups[index].append(part)} else {groups.append([part])}
        }
        return groups.map { group in
            let ordered=group.sorted {$0.1.minX<$1.1.minX}
            let filtered=ordered.enumerated().filter {index,part in
                if part.1.maxX<0.09,index+1<ordered.count,ordered[index+1].1.minX-part.1.maxX>0.015,pixelText(part.0).count<=2 {return false}
                if part.1.minX>0.87,index>0,part.1.minX-ordered[index-1].1.maxX>0.04,pixelText(part.0).count<=3 {return false}
                return true
            }.map {$0.element.0}
            return filtered.joined(separator:" ")
        }
    }
    static func capture(pid:pid_t,windowFrame:CGRect,inputFrame:CGRect,query:String,rows:[[String:String]],
                        foreground:@escaping()->Bool,completion:@escaping(PixelReading)->Void) {
        SCShareableContent.getExcludingDesktopWindows(true,onScreenWindowsOnly:true) { content,error in
            guard let content,error == nil else {completion(PixelReading(error:"shareable_window_unavailable"));return}
            let candidates=content.windows.filter {$0.owningApplication?.processID==pid && $0.isOnScreen}
            let window=candidates.min { a,b in
                abs(a.frame.width-windowFrame.width)+abs(a.frame.height-windowFrame.height) < abs(b.frame.width-windowFrame.width)+abs(b.frame.height-windowFrame.height)
            }
            guard let window,abs(window.frame.width-windowFrame.width)<8,abs(window.frame.height-windowFrame.height)<8 else {
                completion(PixelReading(error:"alfred_window_not_identified"));return
            }
            let filter=SCContentFilter(desktopIndependentWindow:window),config=SCStreamConfiguration()
            config.width=Int(window.frame.width*2);config.height=Int(window.frame.height*2)
            config.showsCursor=false;config.ignoreShadowsSingleWindow=true
            var reading=PixelReading();reading.windowID=window.windowID;reading.captureStarted=timingNow()
            SCScreenshotManager.captureImage(contentFilter:filter,configuration:config) { image,error in
                reading.captured=timingNow()
                guard let image,error == nil else {reading.error="window_capture_failed";completion(reading);return}
                DispatchQueue.main.async {
                    guard foreground() else {reading.error="window_not_foreground_at_capture";completion(reading);return}
                    DispatchQueue.global(qos:.userInitiated).async {
                        let scaleX=CGFloat(image.width)/windowFrame.width,scaleY=CGFloat(image.height)/windowFrame.height
                        let relative=CGRect(x:inputFrame.minX-windowFrame.minX,y:inputFrame.minY-windowFrame.minY,width:inputFrame.width,height:inputFrame.height)
                        let queryRect=CGRect(x:relative.minX*scaleX,y:relative.minY*scaleY,width:relative.width*scaleX,height:relative.height*scaleY).integral
                        do {
                            let all=try PixelProbe.candidates(image)
                            func box(_ c:VNRecognizedText)->CGRect? {
                                guard let normalized=try? c.boundingBox(for:c.string.startIndex..<c.string.endIndex)?.boundingBox else {return nil}
                                return CGRect(x:normalized.minX*CGFloat(image.width),y:(1-normalized.maxY)*CGFloat(image.height),
                                              width:normalized.width*CGFloat(image.width),height:normalized.height*CGFloat(image.height))
                            }
                            let inputCandidates=all.compactMap {c -> (VNRecognizedText,CGRect)? in
                                guard let b=box(c),queryRect.contains(CGPoint(x:b.midX,y:b.midY)) else {return nil};return (c,b)
                            }
                            guard let first=inputCandidates.min(by:{$0.1.midY<$1.1.midY}) else {
                                reading.error="query_region_text_not_detected";completion(reading);return
                            }
                            let header=inputCandidates.filter {abs($0.1.midY-first.1.midY)<max(4,first.1.height*0.5)}.sorted {$0.1.minX<$1.1.minX}
                            let inputLines=header.map {$0.0.string}+[header.map {$0.0.string}.joined(separator:" ")]
                            let resultsTop=header.map {$0.1.maxY}.max()!+2
                            let resultCandidates=all.filter {c in guard let b=box(c) else {return false};return b.minY>resultsTop}
                            let needle=pixelText(query)
                            reading.queryMatches=inputLines.contains {let text=pixelText($0);return text==needle || text=="t"+needle}
                            reading.observedLines=resultCandidates.count
                            let joined=joinedLines(resultCandidates)
                            reading.matchedTitles=rows.filter { row in
                                joined.contains {pixelText($0)==pixelText(row["title"] ?? "")} || resultCandidates.contains {matches($0,title:row["title"] ?? "")}
                            }.count
                            let titles=rows.map {$0["title"] ?? ""}
                            reading.rowsMatch = !titles.isEmpty && Set(titles).allSatisfy {title in
                                max(joined.filter {pixelText($0)==pixelText(title)}.count,resultCandidates.filter {matches($0,title:title)}.count) >= titles.filter {$0==title}.count
                            }
                        } catch {reading.error="local_text_recognition_failed"}
                        reading.recognized=timingNow();completion(reading)
                    }
                }
            }
        }
    }
}
