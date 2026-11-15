Bookmark Workspaces v0.2.0 adds an optional native Control-Tab preview switcher for macOS.

- Tap Control-Tab to return to the previous tab; hold Control to preview recent tabs, cycle with Tab/Shift-Tab, release to confirm, or Escape to cancel.
- Show up to five preview cards at once while cycling the current window's MRU order. The order stays frozen during the gesture.
- Capture only actually viewed pages, verify the focused window and current webpage, and crop out browser toolbars. Keep at most 20 thumbnails in memory; unvisited or unverifiable pages use title placeholders.
- Select existing tabs only, rechecking tab ID, URL, focused window and the original active tab. No new tabs or cross-window moves are performed.
- Keep the existing Alfred search order, history cap, bookmark names, grouping and recent-tab extension command.

The helper is optional and must be installed separately. It needs Accessibility, Input Monitoring and Screen Recording permissions, independent of the diagnostics app. It captures no audio and saves no page screenshots. The macOS bundle includes an Apple Silicon/Intel helper executable and source installer.

No personal configuration, bookmark data or runtime images are included. macOS binaries are ad-hoc signed and are not Apple-notarized; source-build instructions remain available in the README.
