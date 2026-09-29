---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Runner image: take Pi to `0.99.1`, Claude Code to `2.1.285` and Codex to `0.159.0`, and the two Pi
extensions (`rpiv-todo`, `rpiv-web-tools`) to `2.11.0`.

The three agent CLI pins are the documented exception to the 24h release-age window, so each is its
newest published release. Every flag the harness passes to each CLI is still accepted (checked
against the installed binaries). Codex `0.159.0` is the release that serves `gpt-6.1-sol`, which is
now its floor. The Pi extensions do not take the exemption: `2.11.0` is eight days old.

Pi `0.99` ships a built-in MCP client, and the image now wires a Pi run's tool servers into it: see
the `@cat-factory/kernel` changeset. The image reports the new `piMcpServers` body capability for
that, and the Dockerfile records `0.99.0` as the Pi floor it depends on.

Image content changed, so the harness version and every tag pin move with it, which is what makes a
deployment's next `image:publish` actually roll out.
