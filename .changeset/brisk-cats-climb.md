---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Runner image: take Claude Code to `2.1.281`, Codex to `0.156.1` and Pi to `0.87.1`.

The three agent CLI pins are the documented exception to the 24h release-age window the workspace
dependencies are held to, so this takes the newest published release of each rather than the newest
aged one. The Codex move keeps every flag the harness passes to `codex exec` (`--json`,
`--skip-git-repo-check`, `--dangerously-bypass-approvals-and-sandbox`, `--model`), and it stays
above the `0.153.0` floor the catalog depends on. Pi's `0.87` breaking changes are to its extension
and SDK surfaces, which the harness does not use; it drives Pi through `-p --mode json`, which is
unchanged. The two Pi extensions stay at `2.10.1`: they do not take the exemption, and `2.11.0`
differs from it only in its own version numbers.

Image content changed, so the harness version and every tag pin move with it, which is what makes a
deployment's next `image:publish` actually roll out.
