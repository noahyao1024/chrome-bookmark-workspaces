# Optional Control-Tab previews

The optional macOS helper shows a floating preview of recent tabs in the focused normal Chrome window of the configured profile. It requires the matching extension and native bridge. It is separate from Alfred and from the optional diagnostics app.

- Tap Control-Tab and release Control to return to the previous tab without showing the panel.
- Hold Control for at least 180 ms after pressing Tab to show previews. Press Tab again to advance; Shift-Tab or the left arrow reverses direction.
- Release Control, press Return, or click a card to select the highlighted tab. Escape cancels.
- The order is frozen during each gesture. Previewing does not activate tabs; selection only focuses an existing tab and never creates a page.
- The shortcut applies only while Chrome is frontmost. The existing recent-tab extension command remains available.

## Install

On macOS 14 or newer, from the extracted macOS bundle:

```sh
python3 tab-switcher/install.py --profile Default --request-permissions
```

Use the same profile directory as the extension/native bridge. Grant **Bookmark Workspaces Switcher** Accessibility, Input Monitoring, and Screen & System Audio Recording in macOS Privacy & Security settings. Recording permission is used only for window screenshots; no audio is captured. If macOS asks to quit and reopen the app, accept. Use the menu-bar icon to pause or quit the helper or request missing permissions again.

The app is installed under `~/Applications` and starts at login. The public release includes an Apple Silicon/Intel executable. Source installation requires Xcode Command Line Tools and compiles the helper locally.

## Preview and data boundaries

Thumbnails are captured only for the Chrome page that is actually visible, in response to tab/window changes. Window geometry and the accessibility web-area URL must match the browser snapshot; the image is cropped to webpage content, excluding browser toolbars. Unverifiable or loading pages remain placeholders. The helper does not visit background tabs to populate previews. Until a page has been viewed, its card displays a title placeholder. At most 20 thumbnails are held in memory, with a maximum size of 640 × 400 pixels each. Images are not saved to disk or sent over the network. Restarting the helper clears them.

The bridge supplies current-window tab metadata over a private Unix socket and rechecks tab ID, URL, focused window, and the original active tab before selecting. Closing, moving, or navigating a target can cancel selection. Other profiles, unfocused windows and incognito windows are rejected. Shortcut handling is suspended when Chrome loses foreground focus.

The health file contains permission flags, counters and process status, without titles, URLs, typed text or images. Existing diagnostics permissions do not grant permissions to this separate app.

## Build and remove

```sh
python3 tab-switcher/install.py --build-only --universal
swiftc tab-switcher/SwitcherCore.swift tab-switcher/SwitcherCoreTests.swift -o .build/switcher-tests
.build/switcher-tests
python3 tab-switcher/install.py --uninstall
```

Removal stops the helper and deletes only its app and login agent. Browser tabs, bookmarks, Alfred and the native bridge are retained.
