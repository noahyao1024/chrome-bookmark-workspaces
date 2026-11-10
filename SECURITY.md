# Local data and security

## Data flow

The Chrome extension reads bookmarks and normal-window tabs through Chrome APIs. The native host communicates over a Unix socket under `~/Library/Caches/BookmarkWorkspaces` with owner-only permissions. It opens no TCP listener. Its native-messaging manifest allows only the extension ID supplied during installation.

The Alfred workflow keeps short-lived bookmark/tab snapshots and copies of the configured profile's history database in its local workflow cache. Those files contain URLs and titles and are user-private. Old invocation caches are removed after ten minutes when another invocation creates a snapshot. Chrome's original history database is not modified.

Metadata logs under `~/Library/Logs/BookmarkWorkspaces` record durations, counts, route names and request IDs. They omit raw search text, URLs, titles, clipboard content and screenshots. Logs rotate at 1 MiB with one previous file. The project has no remote telemetry or upload endpoint.

## Permissions

- `bookmarks`: read the folder tree and invalidate the search/grouping indexes when bookmarks change.
- `tabs` and `tabGroups`: discover and select pages, create requested tabs, and manage Work/Personal groups.
- `storage`: retain app-entry bindings for the browser session.
- `nativeMessaging`: communicate with the installed local host.
- Alfred may require Full Disk Access for history/fallback bookmark reads and Automation access for the JXA fallback.

Optional diagnostics additionally use listen-only keyboard observation, Accessibility and in-memory capture of the Alfred window. They are never installed by the normal native-host installer. See [timing/README.md](timing/README.md) for measurement limits and consent requirements.

## Operational boundaries

Requests are bounded by deadlines. An uncertain tab creation or focus response is not retried automatically, preventing duplicate opens after a lost acknowledgement. URLs, regions, account numbers, query parameters and fragments are significant unless a user explicitly configures a narrower app-entry reuse policy.

Use the extension in one Chrome profile. Chrome does not expose a reliable profile directory identifier through its tabs API; the selected installation/profile pairing is a user configuration boundary. The legacy JXA fallback can enumerate other normal Chrome windows and does not enable the special Gmail mailbox reuse rule.

## Reporting issues

Use the repository's private vulnerability-reporting feature when available. For ordinary bugs, open an issue with sanitized metadata. Do not attach browser databases, cookies, raw bookmark exports, personalized configuration, or unredacted URLs. There is no supported reason to publish credentials or browser data to reproduce a metadata/selection bug.
