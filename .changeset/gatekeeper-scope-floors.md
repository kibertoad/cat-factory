---
'@cat-factory/contracts': minor
'@cat-factory/server': patch
'@cat-factory/sdk': patch
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': minor
---

Publish each `/api/v1` operation's key-scope floor, and ship it as a policy table.

Every public route contract now declares `minScope` (`withMinScope`), the controllers enforce
that same field instead of per-route literals, and the OpenAPI document stamps it as
`x-min-scope` per operation, beside the `x-public-api-scopes` ladder those floors rank against
(spec 1.23.0, additive). A new generated package,
`@cat-factory/gatekeeper-bindings` (`sdk/gatekeeper`), projects the whole surface as a
policy-annotated operation table (scope floors, mutation and transport metadata, invoke thunks
over `@cat-factory/sdk`) for credential-holding front-ends such as a Cloudflare OS Gatekeeper.
Its ladder helpers refuse a scope rung the package does not carry rather than ranking it below
everything, and `resolveConsequence` applies the cautious reading of an unannotated mutation.
First slice of `docs/initiatives/cloudflare-os-gatekeeper.md`.
