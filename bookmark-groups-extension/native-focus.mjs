import aliases from './alias-core.mjs';
const liveURL = tab => tab.pendingUrl || tab.url || '';

export async function focusExisting(api, payload, control = {}) {
  const phases = {}, started = performance.now();
  const miss = reason => ({kind: 'miss', reason, allowFallback: true, phases});
  const failed = reason => ({kind: 'failed', reason, allowFallback: false, phases});
  const expired = () => control.cancelled?.() || (control.expiresAt && Date.now() >= control.expiresAt);
  const progress = stage => control.progress?.(stage);
  if (payload.version !== 1 || typeof payload.url !== 'string' || !/^(https?|file|chrome|about):/i.test(payload.url)) return miss('invalid_request');
  if (payload.forceNew) return miss('force_new');
  let tabId = Number(payload.tabId);
  if (expired()) return failed('expired');
  let tab, win, mark = performance.now();
  let matchType = 'id';
  progress('resolve_entry');
  const entry = control.entries ? await control.entries.resolve(payload) : null;
  if (entry) {
    if (entry.kind !== 'target') return {...entry, phases};
    tabId = entry.tab.id;
    if (expired()) return failed('expired');
    mark = performance.now();progress('validate_tab');
    try { tab = await api.tabs.get(tabId); } catch { return miss('missing_tab'); }
    phases.getTabMs = performance.now() - mark;
    if (!control.entries.matches(entry.rule, tab)) return miss('entry_scope_changed');
  } else if (!Number.isSafeInteger(tabId) || tabId <= 0) {
    // Bookmarks have no tab ID. Query only this extension's profile, never a
    // different profile's /u/0 mailbox. Keep the host focus-only.
    let tabs;
    progress('query_tabs');
    try { tabs = await api.tabs.query({windowType: 'normal'}); } catch { return miss('query_failed'); }
    phases.queryTabsMs = performance.now() - mark;
    const candidates = tabs.filter(t => !t.incognito).sort((a,b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .map(t => ({...t, url: liveURL(t), tabId: String(t.id)}));
    const action = aliases.decide(payload, candidates, {allowMailboxReuse: true, allowGrafanaReuse: true});
    if (action.kind !== 'focus') return miss('no_matching_tab');
    tab = action.tab;tabId = tab.id;
    if (expired()) return failed('expired');
    // Recheck the chosen tab after the query; it may have navigated meanwhile.
    mark = performance.now();
    progress('validate_tab');
    try { tab = await api.tabs.get(tabId); } catch { return miss('missing_tab'); }
    phases.getTabMs = performance.now() - mark;
    const checked = aliases.decide(payload, [{...tab, url: liveURL(tab), tabId: String(tab.id)}], {allowMailboxReuse: true, allowGrafanaReuse: true});
    if (tab.incognito || checked.kind !== 'focus') return miss('url_or_profile_changed');
    matchType = checked.matchType || (liveURL(tab) === payload.url ? 'resolved-url' : 'gmail-mailbox');
  } else {
    progress('validate_tab');
    try { tab = await api.tabs.get(tabId); } catch { return miss('missing_tab'); }
    phases.getTabMs = performance.now() - mark;
    const checked = aliases.decide(payload, [{...tab, url: liveURL(tab), tabId: String(tab.id)}], {allowGrafanaReuse: true});
    if (tab.incognito || checked.kind !== 'focus') return miss('url_or_profile_changed');
    matchType = checked.matchType || 'id';
  }
  const matchedURL = liveURL(tab);
  mark = performance.now();
  progress('get_window');
  try { win = await api.windows.get(tab.windowId); } catch { return miss('missing_window'); }
  phases.getWindowMs = performance.now() - mark;
  if (win.type !== 'normal' || win.incognito) return miss('not_normal');
  if (entry) {
    // Workspace changes during window lookup must stop before foregrounding.
    let live;
    try { live = await api.tabs.get(tabId); } catch { return miss('missing_tab'); }
    if (live.windowId !== win.id || !control.entries.matches(entry.rule, live)) {
      await control.entries.forgetTab(tabId);
      return miss('entry_scope_changed');
    }
  }
  if (expired()) return failed('expired');
  try {
    if (!win.focused || win.state === 'minimized') {
      mark = performance.now();
      progress('foreground_window');
      await api.windows.update(win.id, {focused: true, ...(win.state === 'minimized' ? {state: 'normal'} : {})});
      phases.foregroundMs = performance.now() - mark;
    }
    if (expired()) return failed('expired');
    mark = performance.now();
    progress('select_tab');
    const selected = await api.tabs.update(tabId, {active: true});
    phases.selectTabMs = performance.now() - mark;
    if (selected.id !== tabId || selected.windowId !== win.id) return failed('moved_during_selection');
    if (entry && !control.entries.matches(entry.rule, selected)) {
      await control.entries.forgetTab(tabId);
      return failed('entry_changed_during_selection');
    }
    if (entry) await control.entries.remember(entry.rule, selected);
    if (selected.groupId >= 0) {
      progress('expand_group');
      try {
        const group = await api.tabGroups.get(selected.groupId);
        if (group.collapsed) await api.tabGroups.update(group.id, {collapsed: false});
      } catch { /* The tab is focused even if its group moved or disappeared. */ }
    }
    phases.totalApiMs = performance.now() - started;
    // Navigation after activation must not cause an automatic duplicate opening.
    return {kind: 'focused', tabId: String(tabId), windowId: String(win.id),
      targetURL: liveURL(selected), targetTitle: selected.title || '',
      matchType: entry ? entry.matchType : matchType,
      navigationChanged: liveURL(selected) !== matchedURL, phases};
  } catch { return failed('selection_failed'); }
}
