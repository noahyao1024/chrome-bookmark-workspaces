import Foundation

func snapshot(_ ids:[Int]=[1,3,2]) -> PreviewSnapshot {
    PreviewSnapshot(kind:"recent_tabs",windowId:10,activeTabId:ids[0],tabs:ids.map {
        PreviewTab(id:$0,windowId:10,title:"Page \($0)",url:"https://example.test/\($0)",loading:false,active:$0==ids[0],groupId:-1)
    })
}

@main struct Tests {
    static func main() {
        var core=SwitcherCore()
        var token=core.begin(reverse:false)
        assert(core.load(snapshot(),token:token)==nil)
        assert(core.selected?.id==3 && core.canPreview)
        core.move(reverse:false);assert(core.selected?.id==2)
        core.move(reverse:true);assert(core.selected?.id==3)
        let first=core.release();assert(first?.tab.id==3 && first?.originTabId==1 && !core.holding)

        token=core.begin(reverse:false)
        assert(core.release()==nil && core.holding && !core.canPreview)
        let quick=core.load(snapshot(),token:token)
        assert(quick?.tab.id==3 && !core.holding)

        token=core.begin(reverse:true);_=core.load(snapshot(),token:token)
        assert(core.selected?.id==2);core.move(reverse:false);assert(core.selected?.id==1)
        assert(core.release()==nil && !core.holding)

        token=core.begin(reverse:false);core.cancel()
        assert(core.load(snapshot(),token:token)==nil && !core.holding)
        let stale=token;token=core.begin(reverse:false)
        assert(core.load(snapshot(),token:stale)==nil && core.snapshot==nil)
        for _ in 0..<7 {core.move(reverse:false)}
        _=core.load(snapshot(),token:token);assert(core.selected?.id==2)
        assert(core.release()?.tab.id==2)

        token=core.begin(reverse:false);_=core.load(snapshot([1]),token:token)
        assert(core.release()==nil && !core.holding)
        assert(!snapshot([1,1]).valid)
        assert(!PreviewSnapshot(kind:"recent_tabs",windowId:10,activeTabId:999,tabs:snapshot().tabs).valid)
        print("Switcher core: quick release, MRU cycling, reverse, cancellation, stale responses and single-tab behavior passed")
    }
}
