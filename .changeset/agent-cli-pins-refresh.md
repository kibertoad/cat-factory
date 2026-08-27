---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Take the bundled agent CLIs at their newest releases: Claude Code `2.1.245 → 2.1.246` and Codex
`0.149.1 → 0.150.0`. Pi stays at `0.84.3`, which is still its newest release, as do the two Pi
extensions at `2.7.1`.

Codex `0.150.0` is inside the 24h `minimumReleaseAge` window (published ~4h before this was cut),
so it is taken under the standing exemption the Dockerfile's note carries for exactly these three
CLIs, re-made here as an explicit call. Claude Code `2.1.246` needs no exemption: it has aged past
the window. Claude Code `2.1.247` is published but sits on the `next` dist-tag rather than
`latest`, so it is deliberately not taken; the pins follow the stable line.

The executor image tag rolls to `1.139.0` (base + UI) because republishing over a live tag does not
roll a deployment out.
