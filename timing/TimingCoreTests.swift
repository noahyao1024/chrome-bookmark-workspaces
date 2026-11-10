import Foundation

@main struct TimingCoreTests {
    static func main() {
        var count=0
        func check(_ condition:@autoclosure()->Bool,_ name:String) {precondition(condition(),name);count+=1}
        var records:[TimingObject]=[]
        let engine=TimingEngine {records.append($0)}
        engine.keyboardAllowed=true;engine.accessibilityAllowed=true
        let base=timingNow()-10_000_000_000
        let invoke=engine.capture("invoke",ns:base,captured:base+2_000_000)
        let initial=engine.beginSearch(trace:"prime",query:"",inherited:nil,at:base+50_000_000)
        let rerun=engine.beginSearch(trace:"cold",query:"",inherited:initial.interaction,at:base+180_000_000)
        check(initial===rerun,"rerun must keep the original operation")
        initial.stages["results_ax_visible"]=base+500_000_000
        engine.finish(initial,status:"measured",end:"results_ax_visible")
        let first=records.first {($0["operation"] as? String)==initial.id}!
        check((first["e2eMs"] as? Double)==500,"E2E includes pre-process and rerun time")
        check(first["keydownUptimeNs"] as? String == String(invoke.ns),"kernel key timestamp retained")
        check((first["keydownToStagesMs"] as? [String:Double])?["process_started"]==50,"process start is a separate stage")

        let key=engine.capture("edit",ns:base+1_000_000_000,captured:base+1_001_000_000)
        engine.inputChanged("t private-query",keys:[key],observed:base+1_010_000_000)
        let search=engine.beginSearch(trace:"typed",query:"private-query",inherited:initial.interaction,at:base+1_030_000_000)
        search.rows=[["title":"private-title"]];search.expectedURL="https://private.test/?secret=token"
        search.stages["results_ax_visible"]=base+1_100_000_000
        engine.finish(search,status:"measured",end:"results_ax_visible")
        let typed=records.first {($0["operation"] as? String)==search.id}!
        check(typed["e2eMs"] as? Double == 100,"typed query uses its own keydown")
        let serialized=String(data:try! JSONSerialization.data(withJSONObject:typed),encoding:.utf8)!
        check(!serialized.contains("private-query") && !serialized.contains("private-title") && !serialized.contains("private.test"),"logs exclude input and page contents")

        let enter=engine.capture("accept",ns:base+4_000_000_000,captured:base+4_001_000_000)
        engine.cancelSearch()
        let action=engine.beginAction(trace:"typed",kind:"open",at:base+4_080_000_000,payload:["url":"https://private.test/"])
        check(action.key?.id==enter.id,"Return remains correlated after Alfred dismisses")
        action.stages["target_ax_visible"]=base+4_300_000_000
        engine.finish(action,status:"measured",end:"target_ax_visible")
        let accepted=records.first {($0["operation"] as? String)==action.id}!
        check(accepted["e2eMs"] as? Double==300,"human selection time is excluded")

        let missing=TimingEngine {records.append($0)}
        let unknown=missing.beginSearch(trace:"programmatic",query:"q",inherited:nil,at:base)
        unknown.stages["results_ax_visible"]=base+20_000_000
        missing.finish(unknown,status:"measured",end:"results_ax_visible")
        let unknownRecord=records.first {($0["operation"] as? String)==unknown.id}!
        check(unknownRecord["e2eMs"] is NSNull,"script starts cannot substitute for keydown")
        check(unknownRecord["status"] as? String=="unmeasured","missing permission must not report measured")

        let coalesced=TimingEngine {records.append($0)};coalesced.keyboardAllowed=true;coalesced.accessibilityAllowed=true
        _=coalesced.capture("invoke",ns:base,captured:base)
        let a=coalesced.capture("edit",ns:base+1,captured:base+1),b=coalesced.capture("edit",ns:base+2,captured:base+2)
        coalesced.inputChanged("ab",keys:[a,b],observed:base+3)
        let uncertain=coalesced.beginSearch(trace:"coalesced",query:"ab",inherited:nil,at:base+4)
        check(uncertain.key==nil && uncertain.missing.contains("coalesced_or_unobserved_input"),"coalesced input cannot be guessed")
        _=coalesced.capture("accept",ns:base+10,captured:base+10)
        _=coalesced.capture("accept",ns:base+11,captured:base+11)
        let twice=coalesced.beginAction(trace:"coalesced",kind:"open",at:base+12,payload:[:])
        check(twice.key==nil && twice.missing.contains("ambiguous_keydown"),"multiple Return events cannot be silently paired")
        check(timingMS(200,100)==nil,"backward clocks are invalid, never clamped to zero")

        let late=TimingEngine {records.append($0)};late.keyboardAllowed=true;late.accessibilityAllowed=true
        _=late.capture("invoke",ns:base,captured:base)
        let edit=late.capture("edit",ns:base+20,captured:base+20)
        let lateOp=late.beginSearch(trace:"late-ax",query:"x",inherited:nil,at:base+40)
        late.inputChanged("x",keys:[edit],observed:base+50)
        check(lateOp.key?.id==edit.id,"late AX observation may bind only a real preceding key")
        check(timingScope(target:"com.apple.inputmethod",foreground:"com.google.Chrome")=="com.google.Chrome","HID events may target the input method rather than the foreground app")
        check(timingScope(target:nil,foreground:"com.runningwithcrayons.Alfred")=="com.runningwithcrayons.Alfred","HID events without a target use foreground history")
        check(timingScope(target:"unrelated.app",foreground:"unrelated.app")==nil,"other apps remain out of scope")
        check(timingRowsVisible([["title":"Result A","subtitle":"Detail"]],texts:["Result A"]),"unique accessible result titles can confirm visibility")
        check(!timingRowsVisible([["title":"Same","subtitle":"First"],["title":"Same","subtitle":"Second"]],texts:["Same"]),"ambiguous identical titles need details")
        check(!timingRowsVisible([["title":"Result A"]],texts:[]),"missing result accessibility is not completion")
        check(engine.queryMatches("t","") && engine.queryMatches("t ",""),"Alfred's empty keyword prefix is not user input that supersedes initialization")
        check(engine.queryMatches("t docs  overview","docs overview"),"AX whitespace normalization follows the search query semantics")
        let delayed=TimingEngine {records.append($0)};delayed.keyboardAllowed=true
        let newOp=delayed.beginSearch(trace:"newer-than-probe",query:"new",inherited:nil,at:base+100)
        delayed.inputChanged("old",keys:[],observed:base+150,sampleStarted:base+50)
        check(!newOp.finished,"an old AX snapshot must not cancel a newer search request")
        print("\(count) timing assertions passed")
    }
}
