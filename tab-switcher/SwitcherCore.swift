import Foundation

struct PreviewBounds: Codable, Sendable {
    let left: Double
    let top: Double
    let width: Double
    let height: Double
}

struct PreviewTab: Codable, Equatable, Sendable {
    let id: Int
    let windowId: Int
    let title: String
    let url: String
    let loading: Bool
    let active: Bool
    let groupId: Int
    var cacheKey: String { "\(id)\n\(url)" }
    var label: String { title.isEmpty ? (URL(string:url)?.host ?? "新标签") : title }
    var domain: String { URL(string:url)?.host ?? "Chrome" }
}

struct PreviewSnapshot: Codable, Sendable {
    let kind: String
    let windowId: Int
    let activeTabId: Int
    let tabs: [PreviewTab]
    var bounds: PreviewBounds? = nil
    var valid: Bool {
        kind == "recent_tabs" && windowId > 0 && !tabs.isEmpty && tabs.first?.id == activeTabId &&
        tabs.allSatisfy { $0.id > 0 && $0.windowId == windowId } && Set(tabs.map(\.id)).count == tabs.count
    }
}

struct PreviewSelection {
    let tab: PreviewTab
    let originTabId: Int
}

// Main-thread state only. Ordering is frozen for one hold/release gesture.
struct SwitcherCore {
    private(set) var token = 0
    private(set) var holding = false
    private(set) var released = false
    private(set) var steps = 0
    private(set) var snapshot: PreviewSnapshot?
    var selectedIndex: Int {
        guard let count = snapshot?.tabs.count, count > 0 else { return 0 }
        return ((steps % count) + count) % count
    }
    var selected: PreviewTab? { snapshot?.tabs[selectedIndex] }
    var canPreview: Bool { holding && !released && snapshot != nil }
    mutating func begin(reverse: Bool) -> Int {
        token += 1; holding = true; released = false; snapshot = nil; steps = reverse ? -1 : 1
        return token
    }
    mutating func move(reverse: Bool) {
        guard holding && !released else { return }
        steps += reverse ? -1 : 1
        if let count = snapshot?.tabs.count, count > 0 { steps %= count }
    }
    mutating func choose(_ index: Int) { if holding { steps = index } }
    mutating func load(_ value: PreviewSnapshot, token expected: Int) -> PreviewSelection? {
        guard holding && token == expected && value.valid else { return nil }
        snapshot = value
        return released ? finish() : nil
    }
    mutating func release() -> PreviewSelection? {
        guard holding else { return nil }
        released = true
        return snapshot == nil ? nil : finish()
    }
    private mutating func finish() -> PreviewSelection? {
        defer { holding = false }
        guard let tab = selected, let origin = snapshot?.activeTabId, tab.id != origin else { return nil }
        return PreviewSelection(tab:tab,originTabId:origin)
    }
    mutating func cancel() { token += 1; holding = false; released = false; snapshot = nil }
}
