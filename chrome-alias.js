#!/usr/bin/osascript -l JavaScript
/* Pure search/action logic; shared by the macOS adapter and Node tests. */
var BookmarkWorkspaces = (function () {
  "use strict";
  function normalized(value) {
    return String(value || "").normalize("NFKC").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "").toLowerCase();
  }
  function decoded(value) {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }
  function queryValue(url, key) {
    var query = url.split("?")[1];
    if (!query) return "";
    var pairs = query.split("#")[0].split("&");
    for (var i = 0; i < pairs.length; i++) {
      var parts = pairs[i].split("=");
      if (decoded(parts.shift()) === key) return decoded(parts.join("=").replace(/\+/g, " "));
    }
    return "";
  }
  function dashboardParts(url) {
    // Keep this parser usable in JXA, where URL/URLSearchParams are unavailable.
    // A single trailing slug is descriptive; namespace and UID are identity.
    var parts = /^(https?):\/\/([^/?#]+)((?:\/v[0-9]+)?\/d)\/([A-Za-z0-9_-]+)(?:\/[^/?#]*)?(\?[^#]*)?(#.*)?$/.exec(url);
    if (!parts || !/^grafana(?:[.-]|$)/i.test(parts[2]) || !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(parts[2])) return null;
    var values = new Map();
    try {
      (parts[5] || "").slice(1).split("&").filter(Boolean).forEach(function (pair) {
        var fields = pair.split("=");
        var key = decodeURIComponent(fields.shift().replace(/\+/g, " "));
        var value = decodeURIComponent(fields.join("=").replace(/\+/g, " "));
        if (!values.has(key)) values.set(key, []);
        values.get(key).push(value);
      });
    } catch (_) { return null; }
    var org = values.get("orgId") || [];
    if (org.some(function (value) { return value !== org[0]; })) return null;
    var query = Array.from(values.keys()).sort().map(function (key) {
      var all = values.get(key);
      // Only identical repetitions of these singular fields are redundant.
      // Variable selections keep their multiplicity and per-key order.
      if (["orgId", "from", "to"].indexOf(key) >= 0 && all.every(function (value) { return value === all[0]; })) all = [all[0]];
      return [key, all];
    });
    return {base: [parts[1], parts[2].toLowerCase(), parts[3], parts[4]],
      org: org.length ? org[0] : null, query: query, fragment: parts[6] || ""};
  }
  function dashboardKey(url) {
    // Alias discovery also finds other views; their action URLs stay separate.
    var parts = dashboardParts(url);
    return parts ? JSON.stringify([parts.base, parts.org]) : null;
  }
  function grafanaKey(url) {
    var parts = dashboardParts(url);
    return parts ? JSON.stringify([parts.base, parts.query, parts.fragment]) : null;
  }
  function gmailAccount(url, inboxOnly) {
    // Only an explicit account's mailbox entry may reuse a different Gmail view.
    // Message links, account selectors and query parameters remain significant.
    var parts = /^https:\/\/mail\.google\.com\/mail\/u\/(\d+)\/(?:#(.*))?$/.exec(url);
    if (!parts || (inboxOnly && parts[2] && parts[2] !== "inbox")) return null;
    return parts[1];
  }
  function flatten(document) {
    var result = [];
    function visit(node, parents) {
      if (node.type === "url") {
        // Work/Personal already identify the category; omit Chrome's root label.
        var path = parents.length > 1 && /^(work|personal)$/i.test(parents[1]) ? parents.slice(1) : parents;
        result.push({ title: node.name, url: node.url, path: path.join(" / "), id: node.id });
      } else {
        (node.children || []).forEach(function (child) { visit(child, parents.concat(node.name || [])); });
      }
    }
    Object.keys(document.roots || {}).forEach(function (key) { visit(document.roots[key], []); });
    return result;
  }
  function rank(text, query, tokens) {
    text = normalized(text);
    if (!query) return 3;
    if (text === query) return 0;
    if (text.indexOf(query) === 0) return 1;
    if (tokens.every(function (token) { return text.indexOf(token) >= 0; })) return 2;
    return 4;
  }
  function addSearchAliases(bookmarks, aliases) {
    var result = bookmarks.slice();
    (Array.isArray(aliases) ? aliases : []).forEach(function (alias) {
      if (!alias || typeof alias.url !== "string" || typeof alias.title !== "string" || !alias.title.trim()) return;
      var saved = bookmarks.find(function (b) { return b.url === alias.url; });
      // An alias only augments a bookmark that still exists at the same full URL.
      if (!saved || result.some(function (b) { return b.url === alias.url && normalized(b.title).trim() === normalized(alias.title).trim(); })) return;
      result.push(Object.assign({}, saved, {title: alias.title}));
    });
    return result;
  }
  function archivedBookmark(bookmark) {
    return /(?:^| \/ )(?:archive|archived)(?: \/ |$)/i.test(bookmark.path || "");
  }
  function urlParts(value) {
    var match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(value);
    if (!match) return {origin: "", path: "", plain: value.split("#")[0]};
    // Context labels never expose credentials or arbitrary query/fragment data.
    return {origin: match[1].toLowerCase() + "://" + match[2].replace(/^.*@/, ""),
      path: match[3] || "/", plain: value.split("#")[0]};
  }
  function collisionContext(url, peers) {
    var parsed = peers.map(urlParts);
    function different(key) {
      var values = parsed.map(function (p) { return queryValue(p.plain, key); });
      return values.some(function (value) { return value !== values[0]; });
    }
    function describe(value) {
      var part = urlParts(value), labels = [];
      function add(value) { if (value) labels.push(String(value).replace(/\s+/g, " ").slice(0, 90)); }
      var regionKey = ["zone", "region", "var-VRegion", "var-region", "regionList"].find(different);
      if (regionKey) add(queryValue(part.plain, regionKey) || "区域未指定");
      var viewKey = ["mode", "module", "tab"].find(different);
      if (viewKey) {
        var view = queryValue(part.plain, viewKey);
        var views = {Egress: "出站", Ingress: "入站", cluster: "集群视图", instance: "实例视图",
          service_overview: "服务概览", service_upstream: "上游服务", service_downstream: "下游服务"};
        add(Object.prototype.hasOwnProperty.call(views, view) ? views[view] : (view ? "视图 " + view : "视图未指定"));
      }
      var clusterKey = ["service_cluster", "var-cluster"].find(different);
      if (clusterKey) add("集群 " + (queryValue(part.plain, clusterKey) || "未指定"));
      var sourceKey = ["var-datasource", "var-bosun_datasource"].find(different);
      if (sourceKey) add("数据源 " + (queryValue(part.plain, sourceKey) || "未指定"));
      if (parsed.some(function (p) { return p.path !== parsed[0].path; })) {
        if (/\/commits(?:\/|$)/.test(part.path)) add("提交记录");
        else if (parsed.some(function (p) { return p.path.indexOf(part.path.replace(/\/$/, "") + "/commits/") === 0; })) add("仓库首页");
        else if (/\/serviceList\/fav\/?$/.test(part.path)) add("收藏服务");
        else if (/\/serviceList\/?$/.test(part.path)) add("全部服务");
        else if (/\/feature_engineering\/extract_feature\/?$/.test(part.path)) add("特征提取");
        else if (/\/feature_engineering\/original_feature\/?$/.test(part.path)) add("原始特征");
        else add("路径 " + part.path);
      }
      if (!labels.length && parsed.some(function (p) { return p.origin !== parsed[0].origin; })) add(part.origin);
      return labels.slice(0, 3).join(" · ");
    }
    var label = describe(url);
    if (!label || peers.filter(function (peer) { return describe(peer) === label; }).length > 1) {
      var position = peers.indexOf(url);
      label += (label ? " · " : "") + (position < 0 ? "当前视图" : "保存视图 " + (position + 1));
    }
    return label;
  }
  function items(bookmarks, tabs, query, tabsKnown, options) {
    options = options || {};
    query = normalized(query).trim();
    var tokens = query.split(/\s+/).filter(Boolean), groups = new Map(), dashboards = new Map(), nameURLs = new Map();
    function entry(url) {
      if (!groups.has(url)) groups.set(url, { url: url, bookmarks: [], tabs: [], order: groups.size });
      return groups.get(url);
    }
    bookmarks.forEach(function (b) {
      if (!b.url) return;
      entry(b.url).bookmarks.push(b);
      var nameKey = normalized(b.title).trim();
      if (nameKey) {
        if (!nameURLs.has(nameKey)) nameURLs.set(nameKey, new Set());
        nameURLs.get(nameKey).add(b.url);
      }
      var key = dashboardKey(b.url);
      if (key) {
        if (!dashboards.has(key)) dashboards.set(key, []);
        dashboards.get(key).push(b);
      }
    });
    tabs.forEach(function (t) { if (t.url) entry(t.url).tabs.push(t); });
    var entryPolicies = options.entryPolicies || [], entryTargets = options.entryTargets || [];
    var results = [];
    groups.forEach(function (g) {
      var links = entryTargets.filter(function (target) {
        return target.url === g.url && target.entryURL === g.url && entryPolicies.some(function (p) { return p.id === target.entryId && p.url === target.entryURL; }) &&
          bookmarks.some(function (b) { return b.url === target.entryURL; }) &&
          g.tabs.some(function (t) { return String(t.tabId) === String(target.tabId) && String(t.windowId) === String(target.windowId); });
      }).sort(function (a, b) { return Number(!!b.bound) - Number(!!a.bound); });
      var link = links[0];
      var related = g.tabs.length ? (dashboards.get(dashboardKey(g.url)) || []).filter(function (b) { return b.url !== g.url; }) : [];
      var saved = g.bookmarks.concat(related);
      var hasArchive = saved.some(archivedBookmark);
      var archived = !g.tabs.length && saved.length > 0 && saved.every(archivedBookmark);
      var searchable = normalized([decoded(g.url)].concat(
        saved.map(function (b) { return b.title + " " + b.path; }),
        g.tabs.map(function (t) { return t.title; })
      ).join(" ") + (hasArchive ? " archive 归档" : ""));
      var sorted = saved.slice().sort(function (a, b) { return rank(a.title, query, tokens) - rank(b.title, query, tokens); });
      var bookmark = sorted[0], tab = link ? g.tabs.find(function (t) {
        return String(t.tabId) === String(link.tabId) && String(t.windowId) === String(link.windowId);
      }) : g.tabs[0];
      var title = bookmark ? bookmark.title : (tab.title || g.url);
      var payload = { version: 1, url: g.url };
      if (tab) {
        payload.windowId = tab.windowId; payload.tabId = tab.tabId;
        if (Number.isSafeInteger(tab.tabIndex) && tab.tabIndex > 0) payload.tabIndex = tab.tabIndex;
      }
      var entryPolicy = link || (!tab && entryPolicies.find(function (p) { return p.url === g.url; }));
      if (entryPolicy) {
        payload.entryId = link ? link.entryId : entryPolicy.id;
        payload.entryURL = link ? link.entryURL : entryPolicy.url;
      }
      var state = tab ? "已打开 · ↩ 切换" : (tabsKnown ? "书签 · ↩ 打开" : "书签 · 标签状态未读取");
      var region = dashboardKey(g.url) ? queryValue(g.url, "var-VRegion") : "";
      if (region) state += " · " + region;
      var detail = bookmark ? bookmark.path : (tab.windowName || "Chrome");
      var aliases = sorted.map(function (b) { return b.title; }).filter(function (name, i, all) { return all.indexOf(name) === i && name !== title; });
      // Keep aliases in the search index; the visible title is one saved name.
      var collision = sorted.find(function (b) { var urls = nameURLs.get(normalized(b.title).trim()); return urls && urls.size > 1; });
      var context = collision ? collisionContext(g.url, Array.from(nameURLs.get(normalized(collision.title).trim()))) : "";
      searchable += context ? " " + normalized(context) : "";
      if (!tokens.every(function (token) { return searchable.indexOf(token) >= 0; })) return;
      var subtitle = state + (context ? " · " + context : "") + " · " + detail + (aliases.length ? " · 别名：" + aliases.join(" / ") : "");
      if (link) subtitle += " · " + (tab.title || g.url);
      results.push({
        score: rank(title, query, tokens), archived: archived, opened: !!tab, entryBound: !!(link && link.bound), order: g.order,
        item: { title: title, subtitle: subtitle, arg: JSON.stringify(payload), valid: true,
          _entry: !!entryPolicy,
          _archived: archived,
          _source: tab ? (g.bookmarks.length ? "opened-bookmark" : (related.length ? "opened-related" : "opened")) : "bookmark",
          _aliases: sorted.map(function (b) { return b.title; }),
          match: searchable + " " + searchable.replace(/[./?&=#:_-]+/g, " "),
          text: { copy: g.url, largetype: title + "\n" + g.url },
          mods: {
            cmd: { valid: true, subtitle: "另开一个标签", arg: JSON.stringify(Object.assign({}, payload, { forceNew: true })) },
            ctrl: { valid: true, subtitle: "复制完整网址", arg: g.url }
          }
        }
      });
    });
    // Entry aliases are separate actions from exact deep-link bookmarks, even
    // when both currently point at the same live page.
    var addedEntries = new Set();
    entryTargets.slice().sort(function (a, b) { return Number(!!b.bound) - Number(!!a.bound); }).forEach(function (target) {
      if (target.url === target.entryURL || !entryPolicies.some(function (p) { return p.id === target.entryId && p.url === target.entryURL; })) return;
      var identity = JSON.stringify([target.entryId, target.url]);
      if (addedEntries.has(identity)) return;
      var tab = tabs.find(function (t) { return t.url === target.url && String(t.tabId) === String(target.tabId) && String(t.windowId) === String(target.windowId); });
      var saved = bookmarks.filter(function (b) { return b.url === target.entryURL; });
      if (!tab || !saved.length) return;
      addedEntries.add(identity);
      var virtual = saved.map(function (b) { return Object.assign({}, b, {url: target.url}); });
      var rows = items(virtual, [tab], query, tabsKnown, {indexMode: !!options.indexMode});
      rows.forEach(function (row) {
        var payload = JSON.parse(row.arg);
        payload.entryId = target.entryId;payload.entryURL = target.entryURL;
        row.arg = JSON.stringify(payload);
        row.mods.cmd.arg = JSON.stringify(Object.assign({}, payload, {forceNew: true}));
        row._source = "opened-related";
        row._entry = true;
        row.subtitle += " · " + (tab.title || tab.url);
        results.push({score: rank(row.title, query, tokens), opened: true, entryBound: !!target.bound,
          order: groups.size + results.length, item: row});
      });
    });
    results.sort(function (a, b) { return Number(!!a.archived) - Number(!!b.archived) || a.score - b.score || Number(b.opened) - Number(a.opened) || Number(b.entryBound) - Number(a.entryBound) || a.order - b.order; });
    return (options.indexMode ? results : results.slice(0, 150)).map(function (r) { return r.item; });
  }
  function decide(payload, tabs, options) {
    if (payload.version !== 1 || typeof payload.url !== "string" || !/^(https?|file|chrome|about):/i.test(payload.url)) {
      throw new Error("不支持的网址格式");
    }
    if (!payload.forceNew) {
      var matches = tabs.filter(function (t) { return t.url === payload.url; });
      var selected = matches.find(function (t) { return String(t.tabId) === String(payload.tabId) && String(t.windowId) === String(payload.windowId); });
      if (selected || matches[0]) return { kind: "focus", tab: selected || matches[0] };
      // Only the extension can prove these tabs belong to the configured profile.
      var account = options && options.allowMailboxReuse ? gmailAccount(payload.url, true) : null;
      if (account !== null) {
        var mailbox = tabs.find(function (t) { return gmailAccount(t.url, false) === account; });
        if (mailbox) return { kind: "focus", tab: mailbox };
      }
      var dashboard = options && options.allowGrafanaReuse ? grafanaKey(payload.url) : null;
      if (dashboard !== null) {
        var sameView = tabs.filter(function (t) { return grafanaKey(t.url) === dashboard; });
        var hinted = sameView.find(function (t) { return String(t.tabId) === String(payload.tabId) && String(t.windowId) === String(payload.windowId); });
        if (hinted || sameView[0]) return { kind: "focus", tab: hinted || sameView[0], matchType: "grafana-dashboard" };
      }
    }
    return { kind: "open", url: payload.url };
  }
  return { flatten: flatten, items: items, decide: decide, addSearchAliases: addSearchAliases, grafanaKey: grafanaKey };
})();
if (typeof module !== "undefined") module.exports = BookmarkWorkspaces;

/* Appended to alias-core.js by build.py. Uses macOS built-ins only. */
var foundationLoaded = false;
var actionDiagnostic = null;
function actionPhase(name, started) {
  if (actionDiagnostic) actionDiagnostic.phases[name] = (actionDiagnostic.phases[name] || 0) + Date.now() - started;
}
function actionFlag(name, value) { if (actionDiagnostic) actionDiagnostic[name] = value; }
function writeActionDiagnostic(record) {
  try {
    foundation();
    var env = $.NSProcessInfo.processInfo.environment;
    function value(key) { var v = env.objectForKey($(key)); return v ? ObjC.unwrap(v) : ""; }
    record.trace = value("chrome_action_trace") || value("chrome_search_trace") || "direct-" + record.timeMs;
    record.resultType = value("chrome_result_type") || "unknown";
    var completed = Number(value("chrome_search_completed_ms"));
    if (completed > 0 && record.timeMs >= completed) record.resultAgeMs = record.timeMs - completed;
    var fm = $.NSFileManager.defaultManager, dir = ObjC.unwrap($.NSHomeDirectory()) + "/Library/Logs/BookmarkWorkspaces";
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(dir), true, $({NSFilePosixPermissions: 448}), null);
    var path = dir + "/actions.jsonl", old = path + ".1";
    if (fm.fileExistsAtPath($(path))) {
      var attrs = ObjC.deepUnwrap(fm.attributesOfItemAtPathError($(path), null));
      if (attrs && Number(attrs.NSFileSize) > 1048576) {
        fm.removeItemAtPathError($(old), null);fm.moveItemAtPathToPathError($(path), $(old), null);
      }
    }
    if (!fm.fileExistsAtPath($(path))) fm.createFileAtPathContentsAttributes($(path), $.NSData.data, $({NSFilePosixPermissions: 384}));
    var handle = $.NSFileHandle.fileHandleForWritingAtPath($(path));
    if (handle) { handle.seekToEndOfFile;handle.writeData($(JSON.stringify(record) + "\n").dataUsingEncoding($.NSUTF8StringEncoding));handle.closeFile; }
  } catch (_) { /* Diagnostics must not interrupt the selected action. */ }
}
function foundation() {
  if (!foundationLoaded) { ObjC.import("Foundation"); foundationLoaded = true; }
}

function readText(path) {
  foundation();
  var text = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  if (!text) throw new Error("无法读取 " + path);
  return ObjC.unwrap(text);
}
function configuration() {
  foundation();
  var config = JSON.parse(readText(ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath) + "/alias-config.json"));
  if (!/^[A-Za-z0-9 _.-]+$/.test(config.profile) || config.profile === "." || config.profile === "..") throw new Error("无效的 Chrome Profile");
  return config;
}
function bookmarks(config) {
  var path = ObjC.unwrap($.NSHomeDirectory()) + "/Library/Application Support/Google/Chrome/" + config.profile + "/Bookmarks";
  return BookmarkWorkspaces.flatten(JSON.parse(readText(path)));
}
function searchAliases(config) {
  try {
    var path = ObjC.unwrap($.NSHomeDirectory()) + "/Library/Application Support/BookmarkWorkspaces/search-aliases.json";
    var stored = JSON.parse(readText(path));
    var aliases = stored.version === 1 && stored.profiles && stored.profiles[config.profile];
    return Array.isArray(aliases) ? aliases : [];
  } catch (_) { return []; }
}
function entryConfiguration(config) {
  try {
    var value = JSON.parse(readText(ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath) + "/entry-reuse-config.json"));
    return value.version === 1 && value.profile === config.profile && Array.isArray(value.entries) ? value.entries : [];
  } catch (_) { return []; }
}
function beginEntryTargets(policies) {
  if (!policies.length) return null;
  try {
    var socket = ObjC.unwrap($.NSHomeDirectory()) + "/Library/Caches/BookmarkWorkspaces/native.sock";
    if (!$.NSFileManager.defaultManager.fileExistsAtPath($(socket))) return null;
    var task = $.NSTask.alloc.init, pipe = $.NSPipe.pipe;
    task.launchPath = "/usr/bin/curl";
    task.arguments = ["--silent", "--proxy", "", "--unix-socket", socket, "--max-time", "0.35", "http://localhost/entries"];
    task.standardOutput = pipe;task.standardError = $.NSPipe.pipe;
    task.launch;
    return {task: task, pipe: pipe};
  } catch (_) { return null; }
}
function finishEntryTargets(request) {
  if (!request) return [];
  try {
    var data = request.pipe.fileHandleForReading.readDataToEndOfFile;
    request.task.waitUntilExit;
    if (request.task.terminationStatus !== 0) return [];
    var response = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
    return response.kind === "entries" && Array.isArray(response.targets) ? response.targets : [];
  } catch (_) { return []; }
}
function snapshot() {
  var browser = Application("Google Chrome");
  if (!browser.running()) return [];
  var result = [];
  browser.windows().forEach(function (win) {
    if (win.mode() !== "normal") return;
    var windowId = String(win.id()), ids = win.tabs.id(), urls = win.tabs.url(), titles = win.tabs.title();
    if (ids.length !== urls.length || ids.length !== titles.length) throw new Error("标签正在变化，请重试");
    for (var i = 0; i < ids.length; i++) result.push({
      windowId: windowId, tabId: String(ids[i]), tabIndex: i + 1, url: urls[i] || "", title: titles[i] || "", windowName: "Chrome 窗口 " + windowId
    });
  });
  return result;
}
function activationSnapshot() {
  var browser = Application("Google Chrome");
  if (!browser.running()) return [];
  var result = [], windowCount = 0;
  browser.windows().forEach(function (win) {
    if (win.mode() !== "normal") return;
    windowCount++;
    var windowId = String(win.id()), ids = win.tabs.id(), urls = win.tabs.url();
    if (ids.length !== urls.length) throw new Error("标签正在变化，请重试");
    for (var i = 0; i < ids.length; i++) result.push({windowId: windowId, tabId: String(ids[i]), tabIndex: i + 1, url: urls[i] || ""});
  });
  actionFlag("windowsScanned", windowCount);actionFlag("tabsScanned", result.length);
  return result;
}
function focusPreferred(target) {
  if (target.windowId == null || target.tabId == null) return null;
  var browser = Application("Google Chrome");
  var win, windowProperties, ids, index;
  var lookupStarted = Date.now(), phaseStarted;
  try {
    // The position hint is usable only after validating its live ID and URL.
    win = browser.windows.byId(Number(target.windowId));
    phaseStarted = Date.now();windowProperties = win.properties();actionPhase("windowPropertiesMs", phaseStarted);
    actionFlag("windowMinimized", !!windowProperties.minimized);
    if (windowProperties.mode !== "normal") return null;
    var hint = Number(target.tabIndex);
    if (Number.isSafeInteger(hint) && hint > 0) {
      phaseStarted = Date.now();
      try {
        var hinted = win.tabs[hint - 1].properties();
        if (String(hinted.id) === String(target.tabId) && hinted.url === target.url) index = hint - 1;
      } catch (_) {}
      actionPhase("hintValidationMs", phaseStarted);actionFlag("hintUsed", index != null);
    }
    if (index == null) {
      phaseStarted = Date.now();
      var tabProperties = win.tabs.byId(Number(target.tabId)).properties();
      if (String(tabProperties.id) !== String(target.tabId) || tabProperties.url !== target.url) return null;
      ids = win.tabs.id().map(String);
      index = ids.indexOf(String(target.tabId));
      actionPhase("idLookupMs", phaseStarted);
      if (index < 0) return null;
    }
  } catch (_) { actionPhase("failedPreferredLookupMs", lookupStarted);return null; }
  phaseStarted = Date.now();win.activeTabIndex = index + 1;actionPhase("selectTabMs", phaseStarted);
  // Confirm the selection after using the live index, including reorder races.
  phaseStarted = Date.now();var selected = win.activeTab.properties();actionPhase("verifySelectionMs", phaseStarted);
  actionFlag("targetLoading", !!selected.loading);
  if (String(selected.id) !== String(target.tabId) || selected.url !== target.url) {
    throw new Error("目标标签发生变化，请重新搜索");
  }
  phaseStarted = Date.now();
  if (windowProperties.minimized) win.minimized = false;
  if (windowProperties.index !== 1) win.index = 1;
  browser.activate();
  actionPhase("foregroundMs", phaseStarted);
  return { kind: "focused", windowId: String(target.windowId), tabId: String(target.tabId),
    targetURL: selected.url, targetTitle: selected.title || "" };
}
function focus(target) {
  var result = focusPreferred(target);
  if (result) return result;
  throw new Error("目标标签已移动或关闭，请重新搜索");
}
function openURL(url, config) {
  foundation();
  // Chrome routes this second-instance request to the explicitly selected profile.
  var task = $.NSTask.alloc.init;
  task.launchPath = "/usr/bin/open";
  task.arguments = ["-na", "Google Chrome", "--args", "--profile-directory=" + config.profile, url];
  var started = Date.now();task.launch;actionPhase("openLaunchMs", started);
  started = Date.now();task.waitUntilExit;actionPhase("openWaitMs", started);
  if (task.terminationStatus !== 0) throw new Error("Chrome 未能打开网址");
  return { kind: "opened", profile: config.profile, targetURL: url };
}
function openingConfiguration(config) {
  var started = Date.now(), result = config || configuration();actionPhase("profileReadMs", started);return result;
}
function activate(payload, config) {
  var validated = BookmarkWorkspaces.decide(payload, []);
  if (payload.forceNew) { actionFlag("route", "force-new");return openURL(validated.url, openingConfiguration(config)); }
  var preferred = focusPreferred(payload);
  if (preferred) { actionFlag("route", "preferred-id");return preferred; }
  // Bookmarks and stale IDs still check all normal windows for exact-URL reuse.
  var started = Date.now(), tabs = activationSnapshot();actionPhase("fallbackScanMs", started);
  var action = BookmarkWorkspaces.decide(payload, tabs);actionFlag("route", action.kind === "focus" ? "fallback-focus" : "open");
  return action.kind === "focus" ? focus(action.tab) : openURL(action.url, openingConfiguration(config));
}
function search(query, config, indexMode) {
  var saved = [], tabs = [], warnings = [], tabsKnown = true;
  var policies = entryConfiguration(config), entryRequest = beginEntryTargets(policies);
  try { saved = BookmarkWorkspaces.addSearchAliases(bookmarks(config), searchAliases(config)); } catch (_) {
    warnings.push({ title: "暂时无法读取 Chrome 书签", subtitle: "检查 Profile 设置，以及 Alfred → General → Request Permissions → Full Disk Access", valid: false });
  }
  try { tabs = snapshot(); } catch (_) {
    tabsKnown = false;
    warnings.push({ title: "暂时无法读取 Chrome 标签", subtitle: "系统设置 → 隐私与安全性 → 自动化：允许 Alfred 控制 Google Chrome", valid: false });
  }
  // The extension supplies profile-scoped targets; require their live ID/window/
  // full URL to agree with the search snapshot before associating an alias.
  var rows = BookmarkWorkspaces.items(saved, tabs, query, tabsKnown, {
    indexMode: !!indexMode, entryPolicies: policies, entryTargets: finishEntryTargets(entryRequest)
  });
  if (!rows.length && !warnings.length) rows.push({ title: "没有匹配的标签或书签", subtitle: "试试书签别名、网页标题或网址", valid: false });
  return { items: warnings.concat(rows) };
}
function run(args) {
  var mode = args[0] || "search";
  if (mode === "notify") {
    var app = Application.currentApplication();app.includeStandardAdditions = true;
    app.displayNotification(args[1] || "请重新搜索后重试", {withTitle: "Chrome 别名搜索"});
    return JSON.stringify({kind: "notification"});
  }
  if (mode === "snapshot") return JSON.stringify(snapshot());
  if (mode === "activate") {
    var started = Date.now();actionDiagnostic = {timeMs: started, phases: {}};
    try {
      var payload = JSON.parse(args[1]);actionFlag("hasTargetIDs", payload.tabId != null && payload.windowId != null);
      var result = activate(payload);actionFlag("result", result.kind);return JSON.stringify(result);
    }
    catch (error) {
      actionFlag("result", "error");actionFlag("errorKind", String(error.name || "Error"));
      var code = /\((-?\d+)\)/.exec(String(error.message || ""));if (code) actionFlag("errorCode", Number(code[1]));
      var app = Application.currentApplication(); app.includeStandardAdditions = true;
      app.displayNotification(String(error.message || error), { withTitle: "Chrome 别名搜索" });
      throw error;
    } finally { actionDiagnostic.durationMs = Date.now() - started;writeActionDiagnostic(actionDiagnostic);actionDiagnostic = null; }
  }
  var config = configuration();
  if (mode === "search") return JSON.stringify(search(args[1] || "", config));
  if (mode === "index") return JSON.stringify(search("", config, true));
  if (mode === "diagnose") {
    var saved = bookmarks(config), tabs = snapshot();
    var opened = saved.filter(function (b) { return tabs.some(function (t) { return t.url === b.url; }); });
    return JSON.stringify({ profile: config.profile, bookmarkCount: saved.length, tabCount: tabs.length,
      openedBookmarkCount: opened.length, sample: search("metrics eu ent", config).items.map(function (i) { return { title: i.title, subtitle: i.subtitle }; }) });
  }
  throw new Error("Unknown action");
}
