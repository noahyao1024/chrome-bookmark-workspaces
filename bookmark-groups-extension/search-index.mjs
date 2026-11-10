import aliases from './alias-core.mjs';

export function flattenTree(tree) {
  const convert = node => ({id: node.id, name: node.title, url: node.url,
    type: node.url ? 'url' : 'folder', children: (node.children || []).map(convert)});
  // Chrome's API has an extra, unnamed root above the bookmark containers.
  return aliases.flatten({roots: Object.fromEntries((tree[0]?.children || []).map(node => [node.id, convert(node)]))});
}

export function createSearchIndex(api, entries, config, publish) {
  let saved, localAliases = [], dirty = true, generation = 0, timer, building, stopped = false;
  async function rebuild() {
    if (building) return building;
    building = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        const version = generation;
        const [bookmarks, windows, targets] = await Promise.all([
          saved || api.bookmarks.getTree().then(flattenTree),
          api.windows.getAll({populate: true, windowTypes: ['normal']}),
          entries.targets()
        ]);
        if (version !== generation) {dirty = true; continue;}
        saved = bookmarks;
        const tabs = windows.filter(win => !win.incognito).flatMap(win =>
          (win.tabs || []).filter(tab => !tab.incognito && tab.url).map(tab => ({
            tabId: String(tab.id), windowId: String(win.id), tabIndex: tab.index + 1,
            url: tab.url, title: tab.title || '', windowName: 'Chrome 窗口 ' + win.id
          })));
        const items = aliases.items(aliases.addSearchAliases(saved, localAliases), tabs, '', true,
          {indexMode: true, entryPolicies: config.entries, entryTargets: targets});
        publish({profile: config.profile, generatedAt: Date.now(), items});
      }
    })().finally(() => {building = undefined;});
    try {await building;} catch {dirty = true;}
  }
  function invalidate(bookmarks = false) {
    if (bookmarks) saved = undefined;
    generation++; dirty = true;
    if (!timer && !stopped) timer = setTimeout(() => {timer = undefined; void rebuild();}, 30);
  }
  const listeners = [];
  function listen(event, callback) {
    if (!event?.addListener) return;
    event.addListener(callback); listeners.push([event, callback]);
  }
  for (const key of ['onCreated','onRemoved','onMoved','onDetached','onAttached','onReplaced']) listen(api.tabs[key], () => invalidate());
  listen(api.tabs.onUpdated, (_, change) => {
    if (change.url !== undefined || change.title !== undefined || change.status === 'complete') invalidate();
  });
  for (const key of ['onCreated','onRemoved']) listen(api.windows[key], () => invalidate());
  for (const key of ['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportEnded']) listen(api.bookmarks[key], () => invalidate(true));
  // Repair a missed event or a transient API error without trusting stale state forever.
  const heartbeat = setInterval(() => invalidate(true), 30000);
  heartbeat.unref?.();
  return {
    async configure(value) {localAliases = Array.isArray(value) ? value : []; invalidate(); await rebuild();},
    refresh: rebuild,
    invalidate,
    stop() {stopped = true; clearTimeout(timer); clearInterval(heartbeat); for (const [event, fn] of listeners) event.removeListener?.(fn);}
  };
}
