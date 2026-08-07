---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Register several NAMED outbound webhooks per workspace, instead of one that each integration overwrites

`/api/v1/notification-webhook` was one endpoint per workspace, which made a second integration's
enrolment a destructive act: registering it replaced whatever was already there, and the only symptom
was that the previous receiver went quiet. `GET /api/v1/notification-webhooks` plus
`GET|PUT|DELETE /api/v1/notification-webhooks/:webhookId` are the additive fix. The singular routes
keep working unchanged and now address the reserved id `default`, which appears in the collection
like any other entry, so the two surfaces are two views of one store rather than two stores.

The endpoint id is CALLER-CHOSEN and `PUT` is idempotent by it. That is what the motivating consumer
needs (a credential-holding front-end, the Cloudflare OS gatekeeper of
`docs/initiatives/cloudflare-os-gatekeeper.md`): a Worker booting cold writes its own well-known id
and is enrolled, whether or not it has ever run, with no id table of its own and no
create-or-discover round trip it might be racing a second instance on. A server-minted id would have
pushed exactly that state back onto the caller.

Each endpoint carries its own sealed signing secret and its own three filters, and every rule the
singular routes enforce holds identically: the `admin` floor, keep-on-omit in every field, the
write-only secret, the SSRF guard at the write boundary and per redirect hop. Deliveries FAN OUT
concurrently to every subscribed endpoint, isolated per endpoint. Both properties are deliberate:
the caller awaits the fan-out on a run's terminal path, so serial delivery would make enrolling a
second integration a latency cost on every run, and a shared failure path would let one permanently
broken receiver mask every sibling's health. `deliveryId` is unchanged and carries no endpoint
segment, because each receiver only ever sees its own copy.

Watch for two things in review. `notification_webhooks` is re-keyed to `(workspace_id, id)` on both
stores, and neither generator produces a migration that survives existing rows: the D1 side is the
usual SQLite rebuild, and drizzle-kit's in-place `ALTER` adds `name` as `NOT NULL` with no default,
so both are hand-healed (add nullable, backfill to `default` / `Default`, then constrain). And the
per-workspace cap of 10 is a 409 `webhook_limit_reached` that bounds only what CREATES an endpoint,
since disabling and deleting are the actions an operator at the cap needs.

Additive on the public surface throughout: four new operations, and two new response fields (`id`,
`name`) on a projection consumers already tolerate unknown members of. OpenAPI `info.version` goes to
1.25.0 and all four SDK clients, the MCP facade and the gatekeeper bindings pick the operations up
from the same generation pass.
