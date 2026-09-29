---
'@cat-factory/executor-harness': minor
'@cat-factory/deploy-harness': patch
'@cat-factory/local-server': patch
'@cat-factory/smoketest-harness': patch
'@cat-factory/benchmark-harness': patch
---

Runner image: take Pi to `0.99.1`, Claude Code to `2.1.285` and Codex to `0.159.0`, and the two Pi
extensions (`rpiv-todo`, `rpiv-web-tools`) to `2.11.0`.

The three agent CLI pins are the documented exception to the 24h release-age window, so each is its
newest published release. Every flag the harness passes to each CLI is still accepted (checked
against the installed binaries). Codex `0.159.0` is the release that serves `gpt-6.1-sol`, which is
now its floor. The Pi extensions do not take the exemption: `2.11.0` is eight days old.

Pi `0.99` ships a built-in MCP client, and the image now wires a Pi run's tool servers into it: see
the `@cat-factory/kernel` changeset. The image reports the new `piMcpServers` body capability for
that, but only after asking the installed binary for its version at startup, so an image built with
`PI_VERSION` overridden below `0.99.0` refuses those runs instead of running them blind.

**Pi now runs against a config directory made for each pass** (`PI_CODING_AGENT_DIR`), seeded with
the extensions the image installed and removed after the pass, instead of the home-global
`~/.pi/agent`. The composed `AGENTS.md`, `models.json` and the tool-server `mcp.json` live there, so
no job's Pi state outlives it on a warm-pool container. The tool-server credentials are written into
that owner-only file with Pi's own literal escapes, and never into Pi's environment, which every
process Pi starts inherits.

**Pi now runs with `--no-approve` instead of `--approve`.** The checkout is untrusted, and a trusted
project has Pi load its `.pi/` resources: its own `mcp.json` (servers started beside the declared
ones), extensions, skills, prompts and `SYSTEM.md`. A repository that relied on committed `.pi/`
resources or `.agents/skills` for Pi runs no longer has them applied; its `AGENTS.md` is still read.

**Embedding API break (`@cat-factory/executor-harness/embed`):** `runPi`, `writeAgentsContext` and
`writePiModelsConfig` take a required `agentDir`, created with the newly exported
`createPiAgentDir`. The benchmark and smoketest harnesses moved to it and no longer rewrite
`process.env.HOME`.

Image content changed, so the harness version and every tag pin move with it, which is what makes a
deployment's next `image:publish` actually roll out.

The deploy image moves to `cat-factory-deploy:0.8.1` for the same reason: the dependency refresh
raised its `@types/node` floor, which is one of its declared sources.
