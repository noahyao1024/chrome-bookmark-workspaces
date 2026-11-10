import aliases from './alias-core.mjs';
import {focusExisting} from './native-focus.mjs';

// This runs on the same serialized queue as focus. Never retry an uncertain mutation.
export async function activate(api, payload, control = {}) {
  const failed = reason => ({kind: 'failed', reason, allowFallback: false});
  const expired = () => control.cancelled?.() || (control.expiresAt && Date.now() >= control.expiresAt);
  try {aliases.decide(payload, []);} catch {return failed('invalid_request');}
  if (expired()) return failed('expired');
  let phases = {};
  if (!payload.forceNew) {
    let result = await focusExisting(api, payload, control);
    // A stale exact tab hint can be resolved again, but an app-entry scope change
    // must not silently turn into a new deep-link opening.
    if (result.kind === 'miss' && !payload.entryId && payload.tabId != null &&
        ['missing_tab','url_or_profile_changed','missing_window'].includes(result.reason)) {
      const {tabId, windowId, tabIndex, ...withoutHint} = payload;
      result = await focusExisting(api, withoutHint, control);
    }
    if (result.kind !== 'miss') return result;
    if (!['no_matching_tab','no_matching_entry'].includes(result.reason)) return failed(result.reason);
    if (payload.entryId && payload.url !== payload.entryURL) return failed('entry_scope_changed');
    phases = result.phases || {};
  }
  if (expired()) return failed('expired');
  let win;
  const mark = performance.now();
  control.progress?.('choose_window');
  try {
    win = await api.windows.getLastFocused({windowTypes: ['normal']});
    if (win.incognito || win.type !== 'normal') return failed('not_normal');
  } catch {return {kind: 'miss', reason: 'no_normal_window', allowFallback: true};}
  if (expired()) return failed('expired');
  try {
    if (!win.focused || win.state === 'minimized') {
      await api.windows.update(win.id, {focused: true, ...(win.state === 'minimized' ? {state: 'normal'} : {})});
    }
    if (expired()) return failed('expired');
    control.progress?.('create_tab');
    const beforeCreate = performance.now();
    const tab = await api.tabs.create({windowId: win.id, url: payload.url, active: true});
    phases.createTabMs = performance.now() - beforeCreate;
    phases.openApiMs = performance.now() - mark;
    if (!tab || tab.incognito || tab.windowId !== win.id || !Number.isSafeInteger(tab.id)) return failed('invalid_created_tab');
    // The callback only observes; its failure cannot trigger another creation.
    try {await control.created?.(tab);} catch { /* Optional diagnostics. */ }
    return {kind: 'opened', tabId: String(tab.id), windowId: String(win.id),
      requestedURL: payload.url, targetURL: tab.url || payload.url, targetTitle: tab.title || '',
      active: !!tab.active, committed: !!tab.url && (tab.url !== 'about:blank' || payload.url === 'about:blank'), phases};
  } catch {return failed('creation_unconfirmed');}
}
