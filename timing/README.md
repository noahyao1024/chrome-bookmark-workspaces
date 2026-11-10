# Optional keydown diagnostics

These tools are for investigating latency, not a dependency of normal bookmark search. Start from a source checkout. The default release/native-host installer does not install or launch this app.

```sh
# Compile without installing or starting an observer.
python3 timing/install.py --build-only

# Explicitly install and start the optional user LaunchAgent.
python3 timing/install.py --install
```

In macOS Privacy & Security, grant **Input Monitoring** and **Accessibility** to **Bookmark Workspaces Diagnostics**. To confirm Alfred result pixels when its accessibility tree does not expose rows, also grant **Screen Recording**. No audio is captured. These permissions are not needed for the main workflow.

The observer uses listen-only keyboard taps and original OS event timestamps. It correlates Chrome Command-T, Alfred query edits, Return, Control-Return and the extension's recent-tab command with process, clipboard and UI observations. The default `t` keyword is assumed by the correlation logic. It does not intercept or synthesize keys.

Logs under `~/Library/Logs/BookmarkWorkspaces/` retain stage times, operation IDs, counts and missing-data reasons. Typed characters, queries, URLs, titles, clipboard contents and screenshots are not written to those logs. Transient URL/title matching and Alfred-window OCR remain in memory. Health counters are in `~/Library/Caches/BookmarkWorkspaces/timing-health.json`.

Important measurement limits:

- Missing, ambiguous or invalid-clock key events remain unmeasured. Script start is never substituted for a missing keydown.
- Pixel confirmation is the first matching sampled capture, an observation upper bound rather than exact first paint. OCR completion is recorded separately.
- Tab creation, committed navigation, visible target and navigation completion are separate stages.
- A locked screen suspends observation. Metadata logging and IPC have their own overhead; these are not subtracted from the user's observed time.
- Synthetic tests validate correlation logic, not real keyboard latency or physical display scanout. Current clock-rejection counters can include software-posted or stale events.

```sh
python3 timing/wire_test.py
swiftc timing/TimingCore.swift timing/TimingCoreTests.swift -o .build/timing-tests
.build/timing-tests

# Stop and remove only this optional app/LaunchAgent.
python3 timing/install.py --uninstall
```

Uninstalling preserves existing logs. Disabling the diagnostics app leaves the search and grouping features operational.
