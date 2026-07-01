---
'@cat-factory/cli': patch
---

`cat-factory k3s`: show the real kubectl client version in the probe report (was rendered as
`{` — the leading brace of the `--output=json` payload) and make the k3s-install fallback
platform-aware. k3s is Linux-only, so on Windows/macOS the guided setup now steers to the k3d
(k3s-in-Docker) path instead of printing a `curl … | sh -` command that can't run there.
