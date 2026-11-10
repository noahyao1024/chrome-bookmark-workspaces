# Contributing

Use example domains and synthetic accounts in tests. Keep private configuration in ignored `*.local.json` files. Generated public defaults must have an empty `entries` array.

Run `python3 build.py`, `npm test`, `python3 native-bridge/host_test.py`, and `python3 -m unittest discover -s tests`. On macOS also build the launcher and run the Python launcher/native/wire tests listed in the README. Regenerate icons with `python3 scripts/generate_icons.py` if their drawing code changes.

Preserve exact URL actions, explicit force-new behavior, profile/workspace boundaries, clipboard fidelity, and nonretry behavior after uncertain mutations. Changes to matching/grouping need regression tests for near-miss cases, not just the successful path.

An existing workspace page excluded by query/fragment constraints is not evidence
that the workspace is absent. Block implicit creation in that case. Include
loading/pending-URL cases in entry-reuse regression coverage.

The default installer must not install diagnostic event taps or request screen capture/input-monitoring access. Never write queries, URLs, titles or clipboard contents to metadata logs.

Before a release, build the default package and run `python3 scripts/check_public.py --artifacts`. Do not publish a customized package. Performance claims must distinguish process timing from real keydown/UI observations.
