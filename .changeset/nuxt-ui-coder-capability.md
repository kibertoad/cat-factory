---
'@cat-factory/agents': minor
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Apply the Nuxt UI skill and MCP server to the platform's own coder agents.

Slice 0 (#2247) vendored the `nuxt-ui` skill and declared the MCP server as Claude Code repo
conventions, which reach a local contributor session but not the coder agents this platform runs.
This adds `registerNuxtUiCapability`: an opt-in agent-kind capability that attaches the vendored
skill (a bundled playbook) and the `nuxt-ui` MCP server (`https://ui.nuxt.com/mcp`) to the coder
kinds that author or repair SPA source: `coder`, `fixer`, `ci-fixer`.

It is opt-in per deployment, not a framework default: `defaultAgentKindRegistry()` stays
stack-agnostic, and the Node and Cloudflare facades opt in when they build their own default
registry. A deployment whose repos are not Nuxt gets neither the playbook nor a server pointing at
`ui.nuxt.com`, and a deployment injecting its own registry owns its capability wiring.

The skill text stays single-sourced: `scripts/generate-nuxt-ui-skill.mjs` inlines the vendored
`.claude/skills/nuxt-ui/` tree into a committed generated module (the Worker cannot read the
filesystem at runtime), and `--check` guards it against drift in CI.
