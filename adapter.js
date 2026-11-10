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
