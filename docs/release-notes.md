Bookmark Workspaces v0.1.2 fixes duplicate Grafana tabs after dashboard slug redirects.

- Recognize both `/d/<UID>/...` and `/v<number>/d/<UID>/...` when finding open tabs by bookmark aliases.
- Reuse equivalent dashboard views within the configured profile, preserving scheme, host/port, namespace, UID, organization, time, filters and fragment.
- Normalize query-key order and form encoding; collapse only identical repeated `orgId`, `from` and `to` values. Preserve repeated variable order and multiplicity.
- Apply the same identity to bookmark-folder grouping, leaving conflicting Work/Personal assignments ungrouped.
- Preserve saved URLs, exact-link priority, explicit new-tab/copy actions and the strict cross-profile fallback.
- Add regression coverage for redirected and loading tabs, stale tab hints, repeated activation, query boundaries and ambiguous grouping.

No domain-wide Grafana whitelist or configuration change is required. Existing duplicate tabs are left open.

No personal bookmarks, account/workspace rules, browser databases, local installation records or Apple SF Symbols artwork are included.

macOS binaries are ad-hoc signed and are not Apple-notarized. If Gatekeeper blocks a downloaded executable, follow the README's source-build instructions.
