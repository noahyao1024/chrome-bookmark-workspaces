// Read-only MRU snapshot and focus-only selection for the native Control-Tab UI.
export async function recentTabs(api) {
  const win = await api.windows.getLastFocused({windowTypes: ['normal']});
  if (!win.focused || win.incognito || win.type !== 'normal') return {kind:'miss', reason:'not_focused'};
  const tabs = (await api.tabs.query({windowId:win.id})).filter(t => !t.incognito);
  const active = tabs.find(t => t.active);
  if (!active) return {kind:'miss', reason:'no_current'};
  tabs.sort((a,b) => Number(b.active)-Number(a.active) || (b.lastAccessed || 0)-(a.lastAccessed || 0) || a.index-b.index);
  const latest = await api.windows.get(win.id);
  if (!latest.focused || latest.incognito) return {kind:'miss', reason:'not_focused'};
  const bounds=[win.left,win.top,win.width,win.height].every(Number.isFinite) ? {left:win.left,top:win.top,width:win.width,height:win.height} : null;
  return {kind:'recent_tabs', windowId:win.id, activeTabId:active.id, bounds,
    tabs:tabs.map(t => ({id:t.id,windowId:win.id,title:t.title || '',url:t.pendingUrl || t.url || '',
      loading:!!t.pendingUrl || t.status==='loading',active:!!t.active,groupId:t.groupId ?? -1}))};
}

export async function focusPreview(api, payload, control = {}) {
  const fail = reason => ({kind:'failed',reason,allowFallback:false});
  const expired = () => control.cancelled?.() || (control.expiresAt && Date.now() >= control.expiresAt);
  if (payload.version!==1 || !Number.isSafeInteger(payload.tabId) || payload.tabId<=0 || !Number.isSafeInteger(payload.windowId) || payload.windowId<=0 ||
      !Number.isSafeInteger(payload.originTabId) || payload.originTabId<=0 || typeof payload.url!=='string' || payload.forceNew || payload.entryId) return fail('invalid_request');
  if (expired()) return fail('expired');
  try {
    const tab = await api.tabs.get(payload.tabId);
    if (tab.incognito || tab.windowId!==payload.windowId || (tab.pendingUrl || tab.url || '')!==payload.url) return fail('tab_changed');
    const current = await api.tabs.query({windowId:payload.windowId,active:true});
    if (current.length!==1 || current[0].id!==payload.originTabId || current[0].incognito) return fail('current_changed');
    const win = await api.windows.get(payload.windowId);
    if (!win.focused || win.type!=='normal' || win.incognito) return fail('not_focused');
    if (expired()) return fail('expired');
    const selected = await api.tabs.update(tab.id,{active:true});
    if (selected.windowId!==win.id || selected.id!==tab.id) return fail('moved_during_selection');
    if (selected.groupId>=0) {
      try {const group=await api.tabGroups.get(selected.groupId);if(group.collapsed)await api.tabGroups.update(group.id,{collapsed:false});} catch {}
    }
    return {kind:'focused',tabId:String(tab.id),windowId:String(win.id),matchType:'preview',navigationChanged:(selected.pendingUrl || selected.url || '')!==payload.url};
  } catch {return fail('selection_unconfirmed');}
}
