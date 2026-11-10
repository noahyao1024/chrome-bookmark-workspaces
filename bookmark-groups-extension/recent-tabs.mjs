export function createRecentSwitcher(api) {
  const orders = new Map(), queues = new Map();
  function noteActivated({tabId, windowId}) {
    const order = orders.get(windowId) || [];
    orders.set(windowId, [tabId, ...order.filter(id => id !== tabId)]);
  }
  function forgetTab(tabId, windowId) {
    const order = orders.get(windowId);
    if (order) orders.set(windowId, order.filter(id => id !== tabId));
  }
  function forgetWindow(windowId) { orders.delete(windowId); }

  async function switchPrevious(windowId) {
    const previous = queues.get(windowId) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const tabs = (await api.tabs.query({windowId})).filter(tab => !tab.incognito);
      const active = tabs.find(tab => tab.active);
      if (!active) return {status: 'no-current'};
      const alive = new Set(tabs.map(tab => tab.id));
      const observed = (orders.get(windowId) || []).filter(id => alive.has(id));
      // Chrome 121+ retains lastAccessed across service-worker suspension.
      const unseen = tabs.filter(tab => !observed.includes(tab.id)).sort((a, b) =>
        (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.index - b.index);
      const order = [active.id, ...observed.filter(id => id !== active.id),
        ...unseen.filter(tab => tab.id !== active.id).map(tab => tab.id)];
      orders.set(windowId, order);
      for (const tabId of order.slice(1)) {
        let candidate;
        try { candidate = await api.tabs.get(tabId); }
        catch { forgetTab(tabId, windowId); continue; }
        if (candidate.windowId !== windowId || candidate.incognito) {
          forgetTab(tabId, windowId); continue;
        }
        let selected;
        try { selected = await api.tabs.update(tabId, {active: true}); }
        catch (error) {
          // A close during the API call can skip to the next surviving tab.
          try { await api.tabs.get(tabId); } catch { forgetTab(tabId, windowId); continue; }
          throw error;
        }
        if (selected.windowId !== windowId) { forgetTab(tabId, windowId); continue; }
        noteActivated({tabId: active.id, windowId});
        noteActivated({tabId, windowId});
        if (selected.groupId >= 0 && api.tabGroups) {
          try {
            const group = await api.tabGroups.get(selected.groupId);
            if (group.collapsed) await api.tabGroups.update(group.id, {collapsed: false});
          } catch { /* A group can disappear or move after activation. */ }
        }
        return {status: 'switched', tabId, previousTabId: active.id, windowId};
      }
      return {status: 'no-other'};
    });
    queues.set(windowId, job);
    try { return await job; }
    finally { if (queues.get(windowId) === job) queues.delete(windowId); }
  }
  return {noteActivated, forgetTab, forgetWindow, switchPrevious};
}
