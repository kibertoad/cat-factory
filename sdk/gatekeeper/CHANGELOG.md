# @cat-factory/gatekeeper-bindings

## 0.3.0

### Minor Changes

- eaab22a: Register several NAMED outbound webhooks per workspace, instead of one that each integration overwrites

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
  write-only secret, the SSRF guard at the write boundary and per redirect hop. Deliveries FAN OUT to
  every subscribed endpoint, concurrently but BOUNDED at six in flight, isolated per endpoint, and
  sharing ONE wall-clock budget. All three are deliberate: the caller awaits the fan-out on a run's
  terminal path, so serial delivery would make enrolling a second integration a latency cost on every
  run; six is the Workers ceiling on simultaneous connections, past which a `fetch` queues invisibly
  while the delivery's clock runs, so an unbounded fan-out reports failures it never attempted; and a
  shared failure path would let one permanently broken receiver mask every sibling's health. An
  endpoint the budget never reached is reported as not attempted rather than as a delivery failure.
  `deliveryId` is unchanged and carries no endpoint segment, because each receiver only ever sees its
  own copy.

  Watch for two things in review. `notification_webhooks` is re-keyed to `(workspace_id, id)` on both
  stores, and neither generator produces a migration that survives existing rows: the D1 side is the
  usual SQLite rebuild, and drizzle-kit's in-place `ALTER` adds `name` as `NOT NULL` with no default,
  so both are hand-healed (add nullable, backfill to `default` / `Default`, then constrain). And the
  per-workspace cap of 10 is a 409 `webhook_limit_reached` that bounds only what CREATES an endpoint,
  since disabling and deleting are the actions an operator at the cap needs. The cap is enforced in
  the STORE, because counting in the service and writing a statement later admits two racing
  enrolments, which is the access pattern this exists for: D1 gets it from one conditional upsert,
  Postgres from a transaction-scoped advisory lock per workspace.

  Additive on the public surface throughout: four new operations, and two new response fields (`id`,
  `name`) on a projection consumers already tolerate unknown members of. OpenAPI `info.version` goes to
  1.25.0 and all four SDK clients, the MCP facade and the gatekeeper bindings pick the operations up
  from the same generation pass.

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/sdk@0.22.0

## 0.2.1

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/sdk@0.21.0

## 0.2.0

### Minor Changes

- 1c8df4a: Record what the agent's CLI said about the tool servers it loaded, beside what the dispatch decided

  A step's tool-server record has answered one question since it landed: what the platform wired for
  the agent, and what it withheld and why. It cannot answer the other one. A server that passes every
  check, resolves its credential, survives the budget and reaches the container can still fail to come
  up there: a vendor endpoint that 500s, a pinned `npx` package that no longer resolves, a token the
  vendor revoked between dispatch and launch. In every one of those the prompt promises the agent a
  tool that never exists, and the only evidence was the agent mentioning it in prose, if it noticed.

  The claude-code CLI announces its resolved session before its first model call, naming the MCP
  servers it loaded with a status each, plus the flat list of tools it will expose. The harness reads
  that one event and publishes it on the job view; the engine folds it onto the same
  `step.toolServers` record the dispatch wrote, and the step detail renders it on the existing chips.
  Both halves are kept, never merged into one status: the platform withholding a tool and the CLI
  failing to start one are different faults for different people.

  The distinctions this is built out of are the whole point, because each one reads as a healthy
  server if it collapses:

  - **Not observed is not "nothing was loaded."** Codex's CLI publishes no such report, nor does any
    image older than this one, nor a runner pool whose manifest does not map the field. All of them
    leave the record's observed half ABSENT, and the surface then says nothing at all rather than
    accusing every wired server on every deployment one release behind.
  - **Started-with-no-tools is not started.** A server that connects and exposes nothing reaches the
    agent exactly like one that was never wired, and every other signal about it says healthy, so a
    zero tool count gets its own sentence and an uncounted one stays absent.
  - **A status this build cannot map is not a fault.** The CLI's status words are a third party's
    vocabulary; an unrecognised one records as `unknown` and is rendered neutrally, because painting
    it red would send an operator to debug a working integration each time a CLI adds a word.

  Nothing branches on an observation: this is evidence for a person, not a control signal.
  Correspondingly it rides all three poll dispositions rather than just the live one — a job short
  enough to settle between two polls is never seen running, and a job that fails is the one whose
  post-mortem needs this most.

  Runner-pool operators who proxy the executor-harness verbatim gain
  `response.toolServersPath` on the manifest; leaving it unset costs the diagnostic and never
  produces a false one. Ships with runner image 1.95.0.

  On the public surface this is one additive optional field, `observed` on a step's `toolServers` in
  `GET /api/v1/debug/runs/:runId` (spec `1.24.0`), so a consumer written against the previous version
  parses everything it already knew. The one rule it has to carry across is the first distinction
  above: an absent `observed` is "no observation was made", never "the CLI loaded nothing".

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/sdk@0.20.0

## 0.1.0

### Minor Changes

- 1025674: Publish each `/api/v1` operation's key-scope floor, and ship it as a policy table.

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

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/sdk@0.19.0
