import {buildIndex, categoryFor, createOrganizer} from './grouping.mjs';
import config from './entry-reuse-config.mjs';

let indexPromise;
export function getGroupIndex() {
  if (!indexPromise) indexPromise = chrome.bookmarks.getTree().then(buildIndex).catch(error => {indexPromise = undefined; throw error;});
  return indexPromise;
}
const organizer = createOrganizer(chrome, getGroupIndex, config.entries);
export async function organize(tabId) {
  try {return await organizer.organize(tabId);} catch {return {status: 'interrupted'};}
}
export async function scan(query = {}) {
  await getGroupIndex();
  const tabs = await chrome.tabs.query(query);
  const results = await Promise.all(tabs.filter(tab => !tab.incognito && !tab.pinned && tab.groupId === -1).map(tab => organize(tab.id)));
  return {kind: 'groups_organized', results};
}
export function refreshIndex() {
  indexPromise = undefined;
  scan().catch(() => {});
}
export async function groupingState() {
  const [index, tabs, groups] = await Promise.all([getGroupIndex(), chrome.tabs.query({windowType: 'normal'}), chrome.tabGroups.query({})]);
  const visible = tabs.filter(tab => !tab.incognito);
  const windows = new Set(visible.map(tab => tab.windowId));
  return {kind: 'groups_state', groups: groups.filter(group => windows.has(group.windowId)),
    tabs: visible.map(tab => ({id: tab.id, windowId: tab.windowId, groupId: tab.groupId, pinned: !!tab.pinned,
      category: categoryFor(tab, index, config.entries)}))};
}
