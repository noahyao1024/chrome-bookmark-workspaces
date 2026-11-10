# Bookmark Workspaces

Search Chrome bookmarks by the names you gave them, switch to an existing page, and keep Work and Personal tabs grouped. Includes a Chrome extension, a local native bridge, and a standalone Alfred workflow for macOS.

[简体中文](README.zh-CN.md) · [Releases](https://github.com/noahyao1024/chrome-bookmark-workspaces/releases) · [MIT license](LICENSE)

## What it does

- `t <query>` searches bookmark names, folders, open tabs and local Chrome history.
- Return reuses a matching tab; Command-Return opens another copy; Control-Return copies the full URL.
- Command-T opens this search **only while Chrome is frontmost**. Other apps keep their shortcuts.
- Bookmark names remain useful even when a page's title changes. Same-URL bookmarks retain their aliases in one result.
- `Work` and `Personal` bookmark folders drive tab groups, including nested folders. A missing group is created only when no group of that category is open elsewhere.
- Optional app-entry rules reuse a page within an explicit origin and workspace path. Gmail mailbox reuse respects the account number.
- Archived bookmarks remain searchable but rank below current bookmarks and tabs. Same-name links show distinguishing regions, views or data sources.
- Numbers and expressions such as `1+2` remain literal Google searches. History contributes at most 10 results.
- A Chrome command alternates the two most recently used tabs in the current window. Assign a Chrome-supported shortcut at `chrome://extensions/shortcuts`.

Search is local until you open a URL or select Google search. The extension does not rename, move or delete bookmarks. Result labels currently use Simplified Chinese; bookmark text can be in any language.

## Install

Requirements: macOS 14 or newer, Chrome 121 or newer, Alfred 5 with Powerpack, and Python 3.9 or newer. Release binaries include both Apple Silicon and Intel architectures. Source builds additionally need Xcode Command Line Tools; tests need Node.js 20 or newer.

Release binaries are ad-hoc signed, not Apple-notarized. If macOS blocks a downloaded executable, use the source-build instructions below; no security settings need to be disabled to build your own copy.

When migrating from an earlier local copy, disable its grouping extension and Alfred workflow first. Run only one extension that automatically manages these category groups.

1. Download `bookmark-workspaces-macos-universal.zip` from [Releases](https://github.com/noahyao1024/chrome-bookmark-workspaces/releases) and extract it to a permanent directory.
2. In your chosen Chrome profile, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the extracted `extension` directory. Keep that directory in place.
3. Copy the extension ID shown by Chrome. From the extracted directory, install the native host:

   ```sh
   python3 native-bridge/install.py --extension-id YOUR_EXTENSION_ID --profile Default
   ```

4. Reload the extension from `chrome://extensions` so it connects to the installed host.
5. Open `Bookmark-Workspaces.alfredworkflow` and import it into Alfred. Disable any other workflow using the `t` keyword or Chrome Command-T if they conflict.
6. Create `Work` and/or `Personal` folders directly under your Chrome bookmarks bar, and place bookmarks in them. The folders are not created automatically.

The prebuilt release targets Chrome's `Default` profile directory. For another directory, such as `Profile 1`, build a matching package with the configuration below. Find the directory in `chrome://version` → **Profile Path**; the directory name can differ from the profile's display name. Install the extension in exactly one profile. Simultaneous native-bridge installations in multiple profiles are not supported.

Grant Alfred Full Disk Access if Chrome history or fallback bookmark reads fail. Grant Alfred Automation access to Chrome if the fallback reports that it cannot control Chrome. Basic search does not need Screen Recording or Input Monitoring. There is no need to enable JavaScript from Apple Events in Chrome.

## Configure app-entry reuse

The public default contains no site-specific rules. Copy `config.example.json` to `config.local.json`, which Git ignores. For example:

```json
{
  "version": 1,
  "profile": "Default",
  "entries": [
    {
      "id": "project-work",
      "url": "https://app.example.test/team/issues",
      "scope": {
        "origin": "https://app.example.test",
        "pathPrefix": "/team/",
        "queryKeys": "*",
        "allowFragment": true
      }
    }
  ]
}
```

`url` must equal an existing bookmark's complete URL. A matching bookmark becomes a workspace entry. A unique in-scope tab can be reused; if several unbound candidates exist, select one of the open results. That selection is remembered for the browser session. Specific deep-link actions remain exact.

Use separate path scopes for separate workspaces. `queryKeys: "*"` and `allowFragment: true` are explicit options for apps whose views need arbitrary query parameters or hash routes. They do not widen other entries. Command-Return continues to open the selected URL deliberately.

Loading tabs are eligible for reuse through their pending URL. If pages already
exist under the same origin/path but a restrictive query/fragment rule excludes
them, the action stops with a configuration message instead of creating another
tab. Selecting an eligible open result binds that tab for later entry requests.

Build your private package, then import its workflow, load its matching extension and pass the same profile to the native-host installer:

```sh
python3 scripts/package.py --config config.local.json
```

Private configuration is written only to ignored `dist/` output. Do not publish a customized build. The release check rejects nonempty app-entry rules in public artifacts.

## Build and test

```sh
python3 build.py
npm test
python3 native-bridge/host_test.py
python3 -m unittest discover -s tests

# macOS
python3 build_launcher.py --universal
python3 launcher.test.py
python3 native-launcher.test.py
python3 timing/wire_test.py
python3 scripts/package.py --skip-build
python3 scripts/check_public.py --artifacts
```

`dist/` contains the Alfred workflow, the Chrome extension component, and the full macOS bundle. The package builder creates a new workflow; it does not read or alter your installed Alfred preferences. Icons are original geometric PNGs generated with Python's standard library.

## Behavior and limits

- Tab grouping preserves pinned, incognito and already-grouped tabs. A group in another window is neither duplicated nor moved. Closed/saved groups are not discoverable through the ordinary tab-group API.
- Folder matching is exact except for explicitly configured app-entry scopes and same-account Gmail mailbox views. Ordinary region, account, query and fragment differences stay significant.
- The native index is scoped to the extension's profile. The JXA fallback can see other normal Chrome windows, so use a single profile when relying on fallback tab discovery. New pages always use the configured profile directory.
- Recent-tab switching is a two-tab toggle, not a hold-and-release tab switcher. Chrome may reject reserved shortcuts such as Control-Tab.
- Archive detection uses folders named `Archive` or `Archived`. Type `archive` or `归档` to find their contents explicitly.
- No remote sync backend or telemetry service is included. Chrome's own bookmark sync remains responsible for synchronization.

See [SECURITY.md](SECURITY.md) for local data and permissions. Optional real-keydown diagnostics are documented separately in [timing/README.md](timing/README.md); they are not installed by the default installer.

## Uninstall

Disable or remove the Alfred workflow, remove the Chrome extension, then run:

```sh
python3 native-bridge/install.py --uninstall
```

This removes the native-host registration and its executable files. It preserves bookmarks, tabs, groups, local aliases, caches and logs. Optional diagnostics have their own uninstall command.

## Acknowledgements

Inspired by [Browser Tabs for Alfred](https://github.com/epilande/alfred-browser-tabs). Attribution is retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Original code and generated icons are available under the [MIT License](LICENSE).
