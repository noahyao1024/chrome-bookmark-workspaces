Bookmark Workspaces v0.1.3 fixes long search-result titles introduced by matching Grafana bookmark aliases to redirected tabs.

- Show the single saved name that best matches the query instead of joining all aliases into the main title.
- Keep every alias searchable and preserve names that intentionally contain slashes.
- Apply the same display rule to cached results and large-type previews.
- Preserve Grafana tab reuse, relevance ranking, tab IDs, saved URLs and copy/new-tab actions.

No bookmark names or browser pages are modified. No personal configuration or browsing data is included.

macOS binaries are ad-hoc signed and are not Apple-notarized. If Gatekeeper blocks a downloaded executable, follow the README's source-build instructions.
