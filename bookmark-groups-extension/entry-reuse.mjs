// App-entry reuse is opt-in. Ordinary bookmark and deep-link actions stay exact.
export function withinScope(rule, value) {
  try {
    const url = new URL(value), scope = rule.scope;
    if (!scope || !scope.pathPrefix?.startsWith('/') || !scope.pathPrefix.endsWith('/')) return false;
    if (url.origin !== scope.origin || url.username || url.password || (url.hash && scope.allowFragment !== true)) return false;
    // Do not infer account/workspace boundaries through encoded path segments.
    if (url.pathname.includes('%')) return false;
    if (url.pathname !== scope.pathPrefix.slice(0, -1) && !url.pathname.startsWith(scope.pathPrefix)) return false;
    return scope.queryKeys === '*' || [...url.searchParams.keys()].every(key => (scope.queryKeys || []).includes(key));
  } catch { return false; }
}

export function createEntryReuse(api, configured) {
  const rules = configured.filter(rule => typeof rule.id === 'string' && withinScope(rule, rule.url));
  const byId = new Map(rules.map(rule => [rule.id, rule]));
  const bindings = new Map(), origins = new Map();
  const key = 'chromeAliasEntryBindingsV1';
  const fingerprint = rule => JSON.stringify([rule.url, rule.scope]);
  let writes = Promise.resolve();
  const ready = (async () => {
    try {
      const stored = (await api.storage?.session?.get(key))?.[key];
      for (const row of stored || []) {
        const rule = byId.get(row.entryId);
        if (rule && row.scope === fingerprint(rule) && Number.isSafeInteger(row.tabId) && row.tabId > 0) bindings.set(rule.id, row.tabId);
      }
    } catch { /* A missing session cache cannot authorize reuse. */ }
  })();
  function persist() {
    const value = [...bindings].map(([entryId, tabId]) => ({entryId, tabId, scope: fingerprint(byId.get(entryId))}));
    writes = writes.catch(() => {}).then(() => api.storage?.session?.set({[key]: value})).catch(() => {});
    return writes;
  }
  function matches(rule, tab) {
    return !!tab && !tab.incognito && withinScope(rule, tab.url) && (!tab.pendingUrl || withinScope(rule, tab.pendingUrl));
  }
  async function forgetTab(tabId) {
    await ready;
    origins.delete(tabId);
    let changed = false;
    for (const [entryId, id] of bindings) if (id === tabId) { bindings.delete(entryId); changed = true; }
    if (changed) await persist();
  }
  async function remember(rule, tab) {
    await ready;
    if (!matches(rule, tab)) return;
    bindings.set(rule.id, tab.id);
    origins.delete(tab.id);
    await persist();
  }
  async function observeTab(tab, created = false) {
    await ready;
    if (!tab?.id) return;
    let changed = false;
    for (const [entryId, id] of bindings) {
      if (id === tab.id && !matches(byId.get(entryId), tab)) { bindings.delete(entryId); changed = true; }
    }
    if (created && !tab.incognito) {
      const source = rules.find(rule => rule.url === tab.pendingUrl || rule.url === tab.url);
      if (source) origins.set(tab.id, {entryId: source.id, expires: Date.now() + 60_000});
    }
    const origin = origins.get(tab.id);
    if (origin && (origin.expires < Date.now() || (tab.url && tab.url !== 'about:blank' && !matches(byId.get(origin.entryId), tab)))) origins.delete(tab.id);
    const source = origins.get(tab.id);
    const rule = rules.find(rule => rule.url === tab.url) || (source && byId.get(source.entryId));
    if (rule && !bindings.has(rule.id) && matches(rule, tab)) {
      try {
        const win = await api.windows.get(tab.windowId);
        const live = await api.tabs.get(tab.id);
        if (win.type === 'normal' && !win.incognito && live.windowId === win.id && matches(rule, live) && !bindings.has(rule.id)) {
          bindings.set(rule.id, tab.id);origins.delete(tab.id);changed = true;
        }
      } catch { /* Closed or moved before the source URL could be verified. */ }
    }
    if (changed) await persist();
  }
  async function candidates() {
    return (await api.tabs.query({windowType: 'normal'})).filter(tab => !tab.incognito);
  }
  async function resolve(payload) {
    await ready;
    if (payload.entryId == null) return null;
    const miss = reason => ({kind: 'miss', reason, allowFallback: true});
    const rule = byId.get(payload.entryId);
    if (!rule || payload.entryURL !== rule.url ||
        (payload.url !== rule.url && (payload.tabId == null || !withinScope(rule, payload.url)))) return miss('invalid_entry');
    const target = (tab, matchType) => ({kind: 'target', tab, rule, matchType});
    if (payload.tabId != null) {
      try {
        const tab = await api.tabs.get(Number(payload.tabId));
        return matches(rule, tab) ? target(tab, 'entry-selected') : miss('entry_scope_changed');
      } catch { return miss('missing_tab'); }
    }
    const bound = bindings.get(rule.id);
    if (bound != null) {
      try {
        const tab = await api.tabs.get(bound);
        if (matches(rule, tab)) return target(tab, 'entry-bound');
      } catch { /* Expired browser-session tab ID. */ }
      bindings.delete(rule.id);await persist();
    }
    const tabs = (await candidates()).filter(tab => matches(rule, tab));
    const exact = tabs.filter(tab => tab.url === rule.url).sort((a,b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (exact.length) return target(exact[0], 'entry-exact');
    if (tabs.length === 1) return target(tabs[0], 'entry-unique');
    if (tabs.length > 1) return {kind: 'failed', reason: 'ambiguous_entry', allowFallback: false};
    return miss('no_matching_entry');
  }
  async function targets() {
    await ready;
    const tabs = await candidates(), result = [];
    let changed = false;
    for (const rule of rules) {
      const matchesHere = tabs.filter(tab => matches(rule, tab));
      if (bindings.has(rule.id) && !matchesHere.some(tab => tab.id === bindings.get(rule.id))) {
        bindings.delete(rule.id);changed = true;
      }
      for (const tab of matchesHere) result.push({entryId: rule.id, entryURL: rule.url, tabId: String(tab.id),
        windowId: String(tab.windowId), url: tab.url, bound: bindings.get(rule.id) === tab.id});
    }
    if (changed) await persist();
    return result;
  }
  return {ready, resolve, targets, remember, forgetTab, observeTab, matches};
}
