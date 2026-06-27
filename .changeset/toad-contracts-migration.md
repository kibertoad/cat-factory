---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Adopt `@toad-contracts/*` for end-to-end typed, validated API contracts.

The HTTP boundary is now a single source of truth. Each route is defined once with
`defineApiContract` in `@cat-factory/contracts` (`src/routes/*`) and consumed by both
sides: the backend mounts it with `@toad-contracts/hono`'s `buildHonoRoute` (method,
path and request validation derived from the contract; the handler's `c.req.valid(...)`
inputs and `c.json(body, status)` return are type-checked against it), and the SPA calls
it with `@toad-contracts/frontend-http-client`'s `sendByApiContract` over `wretch`
(runtime-validating every response). The frontend wire-type mirror in
`frontend/app/app/types/*` no longer hand-redefines shapes — it re-exports the inferred
types from `@cat-factory/contracts`, so backend and frontend can't drift.

Breaking / notable:

- `@cat-factory/server` no longer exports `jsonBody`, and drops the
  `@hono/valibot-validator` dependency (request validation now comes from the contract
  via `buildHonoRoute`); request-validation failures still return the same
  `{ error: { code: 'validation', issues } }` 400 envelope, mapped centrally in
  `handleError`.
- `updateBlockSchema` now accepts `responsibleProductUserId` (it was silently dropped on
  the wire despite the domain block carrying it and the mapper persisting it).
- The runtime-internal endpoints that are not request/response JSON APIs (the WebSocket
  event stream, the LLM/web-search proxies, the GitHub webhook, the Slack OAuth callback)
  are intentionally left on plain Hono routing.
- The wire-returned shapes that the kernel ports also describe (`ProvisionedRepo`,
  `AgentContextSnapshot`/`AgentContextFile`/`AgentContextFragment`) now have their single
  source of truth in `@cat-factory/contracts` valibot schemas; the `@cat-factory/kernel`
  ports re-export the inferred types, so the route contract and the port can't drift. The
  `/auth/config` `localMode` field is now a real schema (`localModeConfigSchema`) instead
  of `v.unknown()`, and `AppConfig.localMode` derives its type from it.
