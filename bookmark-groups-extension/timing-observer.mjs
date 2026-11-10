// Passive and bounded: observe only tabs associated with an armed workflow open.
export function createTimingObserver(api, emit, clock = Date.now) {
  const pending = new Map();
  function sweep() {
    for (const [id, item] of pending) if (item.expiresAt <= clock()) pending.delete(id);
  }
  function arm(payload) {
    sweep();
    if (typeof payload.operation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.operation) ||
        typeof payload.url !== 'string' || !/^(https?|file|chrome|about):/i.test(payload.url)) return false;
    const existing=pending.get(payload.operation);
    if (existing && existing.url === payload.url) return true;
    const item={operation: payload.operation, url: payload.url,
      expiresAt: Math.min(Number(payload.expiresAt) || 0, clock() + 15000)};
    pending.set(payload.operation,item);
    const timer=setTimeout(()=>{if(pending.get(payload.operation)===item)pending.delete(payload.operation);},Math.max(0,item.expiresAt-clock()));
    timer.unref?.();
    return true;
  }
  async function report(item, tab) {
    if (tab.incognito || item.expiresAt <= clock()) return;
    let win;
    try {win = await api.windows.get(tab.windowId);} catch {return;}
    if (win.type !== 'normal' || win.incognito) return;
    const committed=!!tab.url && (tab.url !== 'about:blank' || item.url === 'about:blank');
    emit({event: 'opening_target', operation: item.operation, tabId: String(tab.id), windowId: String(tab.windowId),
      url: tab.url === 'about:blank' && item.url !== 'about:blank' ? (tab.pendingUrl || item.url) : (tab.url || tab.pendingUrl || item.url),
      title: tab.title || '', created: true, committed,
      active: !!tab.active && committed, status: committed ? (tab.status || 'loading') : 'loading'});
  }
  async function track(operation, url, tab) {
    if (!pending.has(operation)) arm({operation, url, expiresAt: clock() + 15000});
    const item=pending.get(operation);
    if (!item || item.url !== url || tab.incognito) return;
    item.tabId=tab.id;
    await report(item, tab);
  }
  async function created(tab) {
    sweep();if (tab.incognito) return;
    const matching=[...pending.values()].filter(item => item.tabId == null && (tab.url === item.url || tab.pendingUrl === item.url));
    if (matching.length > 1) {
      for (const item of matching) {emit({event:'opening_ambiguous',operation:item.operation});pending.delete(item.operation);}
      return;
    }
    if (matching.length === 1) {matching[0].tabId=tab.id;await report(matching[0],tab);}
  }
  async function updated(tab) {
    sweep();for (const item of pending.values()) if (item.tabId === tab.id) await report(item,tab);
  }
  async function activated(tabId) {
    sweep();if (![...pending.values()].some(item => item.tabId === tabId)) return;
    try {await updated(await api.tabs.get(tabId));} catch { /* Closed. */ }
  }
  function removed(tabId) {
    for (const [id,item] of pending) if (item.tabId === tabId) {emit({event:'opening_closed',operation:id});pending.delete(id);}
  }
  return {arm,track,created,updated,activated,removed};
}
