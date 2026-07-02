---
'@cat-factory/executor-harness': minor
---

Consume the job body's new `packageRegistries` field: validated against a hard host
allowlist (`registry.npmjs.org`, `npm.pkg.github.com`; entries of an unknown
ecosystem are dropped so future ecosystems stay additive), rendered into a 0600
`~/.npmrc` before any mode runs (read by npm/pnpm/yarn v1 in the agent's shell
installs and the frontend-infra stand-up alike), cleared when a job carries no
entries so a reused warm-pool container never leaks a prior job's token, and the
tokens registered with the shared output redaction. Yarn berry (`.yarnrc.yml`) and
Docker-in-Docker compose image builds do not pick up the auth yet.
