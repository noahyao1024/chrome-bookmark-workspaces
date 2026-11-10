import {focusExisting} from './native-focus.mjs';
import {createEntryReuse} from './entry-reuse.mjs';
import entryConfig from './entry-reuse-config.mjs';
import {createTimingObserver} from './timing-observer.mjs';
import {createSearchIndex} from './search-index.mjs';
import {activate} from './native-activate.mjs';
import {groupingState, scan as organizeGroups} from './grouping-runtime.mjs';

const entries = createEntryReuse(chrome, entryConfig.entries);
chrome.tabs.onCreated.addListener(tab => { entries.observeTab(tab, true).catch(console.warn); });
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.status) entries.observeTab(tab).catch(console.warn);
});
chrome.tabs.onRemoved.addListener(id => { entries.forgetTab(id).catch(console.warn); });
chrome.tabs.onReplaced.addListener((added, removed) => { entries.forgetTab(removed).catch(console.warn); });
entries.ready.then(async () => {
  for (const tab of await chrome.tabs.query({windowType: 'normal'})) await entries.observeTab(tab);
}).catch(console.warn);

let port, reconnectTimer, reconnectDelay = 250;
const searchIndex = createSearchIndex(chrome, entries, entryConfig, index => {
  if (port) {try {port.postMessage({type: 'search_index', index});} catch { /* Rebuilt on reconnect. */ }}
});
export function reportTiming(data) {
  if (port) {try {port.postMessage({type:'timing_event',data});} catch { /* Diagnostics are optional. */ }}
}
const timing = createTimingObserver(chrome, reportTiming);
chrome.tabs.onCreated.addListener(tab => {timing.created(tab).catch(() => {});});
chrome.tabs.onUpdated.addListener((id,change,tab) => {if (change.url || change.status) timing.updated(tab).catch(() => {});});
chrome.tabs.onActivated.addListener(info => {timing.activated(info.tabId).catch(() => {});});
chrome.tabs.onRemoved.addListener(id => timing.removed(id));
const cancelled = new Set();
let sequence = Promise.resolve();
function connect() {
  if (port) return;
  try { port = chrome.runtime.connectNative('io.github.noahyao1024.bookmark_workspaces'); }
  catch { retry(); return; }
  const active = port;
  active.onMessage.addListener(message => {
    if (message.type === 'groups_state' || message.type === 'organize_groups') {
      (async () => {
        if (message.type === 'organize_groups') {
          if (message.expiresAt && Date.now() >= message.expiresAt) return {kind: 'failed', reason: 'expired', allowFallback: false};
          const windowId=message.payload?.windowId;
          if (!Number.isSafeInteger(windowId) || windowId <= 0) return {kind: 'failed', reason: 'invalid_window', allowFallback: false};
          return organizeGroups({windowId});
        }
        return groupingState();
      })().catch(() => ({kind: 'failed', reason: 'grouping_unavailable', allowFallback: false})).then(result => {
        if (active === port) {try {active.postMessage({type: 'result', id: message.id, result});} catch {}}
      });
      return;
    }
    if (message.type === 'configure_search') {
      if (message.profile === entryConfig.profile) searchIndex.configure(message.aliases).catch(() => {});
      return;
    }
    if (message.type === 'timing_arm') {
      const armed=timing.arm(message.payload || {});
      try {active.postMessage({type:'result',id:message.id,result:{kind:armed?'timing_armed':'miss',allowFallback:!armed}});} catch {}
      return;
    }
    if (message.type === 'cancel') {
      cancelled.add(message.id);
      if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value);
      return;
    }
    if (message.type === 'entries') {
      entries.targets().then(targets => ({kind: 'entries', targets})).catch(() => ({kind: 'miss', reason: 'entries_unavailable', allowFallback: true}))
        .then(result => {
          const wasCancelled = cancelled.delete(message.id);
          if (active === port && !wasCancelled) {
            try { active.postMessage({type: 'result', id: message.id, result}); } catch { /* Connection is gone. */ }
          }
        });
      return;
    }
    if (!['focus', 'activate'].includes(message.type)) return;
    const progress = stage => {
      if (active === port) {
        try { active.postMessage({type: 'progress', id: message.id, stage}); } catch { /* Final response reports failure. */ }
      }
    };
    progress('received');
    reconnectDelay = 250;
    sequence = sequence.catch(() => {}).then(async () => {
      const operation = message.timingOperation;
      if (message.type === 'activate' && operation) timing.arm({operation, url: message.payload.url, expiresAt: Date.now() + 15000});
      const result = await (message.type === 'activate' ? activate : focusExisting)(chrome, message.payload, {
        expiresAt: message.expiresAt,
        cancelled: () => cancelled.has(message.id) || active !== port,
        progress, entries,
        created: operation ? tab => timing.track(operation, message.payload.url, tab) : undefined
      });
      if (['focused', 'opened'].includes(result.kind)) searchIndex.invalidate();
      cancelled.delete(message.id);
      if (active === port) {
        try { active.postMessage({type: 'result', id: message.id, result}); }
        catch { active.disconnect(); }
      }
    }).catch(() => {
      if (active === port) active.postMessage({type: 'result', id: message.id,
        result: {kind: 'failed', reason: 'bridge_error', allowFallback: false}});
    });
  });
  active.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    if (error) console.warn('Native switch bridge disconnected:', error.message);
    if (active !== port) return;
    port = undefined;retry();
  });
  try { active.postMessage({type: 'ready', version: 2, profile: entryConfig.profile}); }
  catch { if (active === port) port = undefined;active.disconnect();retry(); }
}
function retry() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined;connect(); }, delay);
}
connect();
