import {organize, scan, refreshIndex} from './grouping-runtime.mjs';
import {createRecentSwitcher} from './recent-tabs.mjs';
import {reportTiming} from './native-bridge.mjs';

const recentSwitcher = createRecentSwitcher(chrome);

chrome.tabs.onCreated.addListener(tab => { organize(tab.id); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === 'loading' || change.status === 'complete') organize(tabId);
});
chrome.tabs.onActivated.addListener(info => { recentSwitcher.noteActivated(info); organize(info.tabId); });
chrome.tabs.onRemoved.addListener((tabId, info) => { recentSwitcher.forgetTab(tabId, info.windowId); });
chrome.tabs.onDetached.addListener((tabId, info) => { recentSwitcher.forgetTab(tabId, info.oldWindowId); });
chrome.windows.onRemoved.addListener(windowId => { recentSwitcher.forgetWindow(windowId); });
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'switch-last-tab' || tab?.incognito) return;
  (async () => {
    const nonce=crypto.randomUUID();reportTiming({event:'mru_begin',nonce});
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused({windowTypes: ['normal']})).id;
    try {
      const result=await recentSwitcher.switchPrevious(windowId);
      const current=result.tabId != null ? await chrome.tabs.get(result.tabId) : undefined;
      reportTiming({event:'mru_end',nonce,status:result.status,active:!!current?.active,
        url:current?.url || '',title:current?.title || '',tabId:current?.id,windowId});
    } catch (error) {reportTiming({event:'mru_end',nonce,status:'failed'});throw error;}
  })().catch(error => console.warn('Recent tab switch could not complete:', error.message));
});
for (const event of [chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onChildrenReordered, chrome.bookmarks.onImportEnded]) {
  event.addListener(refreshIndex);
}
chrome.runtime.onInstalled.addListener(() => { scan().catch(console.warn); });
chrome.runtime.onStartup.addListener(() => { scan().catch(console.warn); });
chrome.action.onClicked.addListener(() => { scan({currentWindow: true}).catch(console.warn); });
