import {withinScope} from './entry-reuse.mjs';
import aliases from './alias-core.mjs';

export const categories = {work: {title: 'Work', color: 'blue'}, personal: {title: 'Personal', color: 'green'}};

export function buildIndex(tree) {
  const index = new Map();
  function collect(node, category) {
    if (node.url) {
      if (!index.has(node.url)) index.set(node.url, new Set());
      index.get(node.url).add(category);
    }
    for (const child of node.children || []) collect(child, category);
  }
  // Match only top-level bookmark folders, not nested names such as My Work.
  for (const root of tree) for (const container of root.children || []) {
    for (const folder of container.children || []) {
      const key = (folder.title || '').toLowerCase();
      if (folder.children && categories[key]) collect(folder, key);
    }
  }
  return index;
}

export function categoryFor(tab, index, entries = []) {
  const dashboard = aliases.grafanaKey(tab.pendingUrl || tab.url || '');
  if (dashboard) {
    const found = new Set();
    for (const [url, categories] of index) {
      if (aliases.grafanaKey(url) === dashboard) for (const category of categories) found.add(category);
    }
    // Equivalent slugs in both folders are ambiguous, even with an exact match.
    if (found.size) return found.size === 1 ? [...found][0] : null;
  }
  // Do not strip query parameters: region and service selectors are significant.
  for (const url of [tab.pendingUrl || tab.url]) {
    const found = index.get(url);
    if (found) return found.size === 1 ? [...found][0] : null;
  }
  // Only explicit application-entry scopes may inherit their bookmark folder
  // after navigation. Ordinary deep links keep exact URL matching.
  const found = new Set();
  for (const entry of entries) {
    if (!withinScope(entry, entry.url)) continue;
    const committed = tab.url && !['about:blank','chrome://newtab/','chrome://new-tab-page/'].includes(tab.url);
    if (!withinScope(entry, tab.pendingUrl || tab.url) || (committed && !withinScope(entry, tab.url))) continue;
    for (const category of index.get(entry.url) || []) found.add(category);
  }
  const mailbox = /^https:\/\/mail\.google\.com\/mail\/u\/(\d+)\/(?:#.*)?$/;
  const account = mailbox.exec(tab.pendingUrl || tab.url || '')?.[1];
  if (account && (!tab.pendingUrl || mailbox.exec(tab.url || '')?.[1] === account)) {
    for (const [url, categories] of index) {
      const saved = /^https:\/\/mail\.google\.com\/mail\/u\/(\d+)\/(?:#inbox)?$/.exec(url);
      if (saved?.[1] === account) for (const category of categories) found.add(category);
    }
  }
  if (found.size === 1) return [...found][0];
  return null;
}

export function createOrganizer(api, getIndex, entries = []) {
  const queues = new Map();
  async function organize(tabId) {
    let initial;
    try { initial = await api.tabs.get(tabId); } catch { return {status: 'closed'}; }
    if (initial.incognito || initial.pinned || initial.groupId !== -1) return {status: 'preserved'};
    const category = categoryFor(initial, await getIndex(), entries);
    if (!category) return {status: 'unmatched'};
    const windowId = initial.windowId;
    // Serialize each category across windows, so simultaneous opens cannot both
    // create a Work group. Existing groups in other windows are left in place.
    const previous = queues.get(category) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      let tab;
      try { tab = await api.tabs.get(tabId); } catch { return {status: 'closed'}; }
      if (tab.windowId !== windowId) return {status: 'moved'};
      if (tab.incognito || tab.pinned || tab.groupId !== -1) return {status: 'preserved'};
      if (categoryFor(tab, await getIndex(), entries) !== category) return {status: 'changed'};
      const groups = (await api.tabGroups.query({})).filter(group => (group.title || '').normalize('NFKC')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim().toLowerCase() === category);
      const existing = groups.find(group => group.windowId === windowId);
      if (!existing && groups.length) return {status: 'group-in-other-window', category};
      try { tab = await api.tabs.get(tabId); } catch { return {status: 'closed'}; }
      if (tab.windowId !== windowId) return {status: 'moved'};
      if (tab.incognito || tab.pinned || tab.groupId !== -1) return {status: 'preserved'};
      if (categoryFor(tab, await getIndex(), entries) !== category) return {status: 'changed'};
      const groupId = await api.tabs.group({tabIds: [tabId], ...(existing ? {groupId: existing.id} : {createProperties: {windowId}})});
      if (!existing) await api.tabGroups.update(groupId, {...categories[category], collapsed: false});
      else if (tab.active && existing.collapsed) await api.tabGroups.update(groupId, {collapsed: false});
      return {status: 'grouped', groupId, category, created: !existing};
    });
    queues.set(category, job);
    try { return await job; } finally { if (queues.get(category) === job) queues.delete(category); }
  }
  return {organize};
}
