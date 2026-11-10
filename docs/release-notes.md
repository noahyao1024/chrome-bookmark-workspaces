Bookmark Workspaces v0.1.1 fixes duplicate app-entry opens after navigation.

- Reuse entries while their initial document is still loading.
- Preserve entry discovery for pending URLs and prefer recently used duplicate targets.
- Stop implicit tab creation when existing workspace pages are excluded by restrictive query or fragment settings.
- Report creation lookup reasons without recording URLs or query contents.
- Add regression coverage for chat/session routes, agent views, pending navigation and cross-workspace boundaries.

Existing restrictive app-entry configurations may need additional query keys or
`queryKeys: "*"` with `allowFragment: true` when the origin/path already defines
the workspace. Private configurations are not modified by the public release.

No personal bookmarks, account/workspace rules, browser databases, local installation records or Apple SF Symbols artwork are included.

macOS binaries are ad-hoc signed and are not Apple-notarized. If Gatekeeper blocks a downloaded executable, follow the README's source-build instructions.
