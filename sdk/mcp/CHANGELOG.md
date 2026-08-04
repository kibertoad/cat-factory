# @cat-factory/mcp-server

## 0.4.0

### Minor Changes

- 8cbf1a7: Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
  headless.

  `GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
  HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
  alerts to. Until now that endpoint could only be registered over the session-authed
  `/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
  human in a browser to switch on the very channel that exists because there is no browser: the
  delivery contract was headless and its enrolment was not.

  The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
  SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
  invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
  accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
  learn the stored one.

  `PUT`'s `url` becomes optional, on both surfaces, so keep-on-omit is uniform across every field
  rather than every field but one. A mandatory re-send made the routine edit (subscribe to a family)
  carry a value the caller never meant to change, and a client re-sending a URL it cached before
  someone else rotated the receiver would silently redirect the workspace's deliveries back to the
  old endpoint while appearing to add a subscription. `url` is still required on the first `PUT`
  against a workspace with nothing registered, refused with `details.reason: "webhook_url_required"`.
  Relaxing a required field is additive, so no live caller changes.

  Additive on `/api/v1` (OpenAPI `info.version` 1.5.0; main took 1.4.0 for its own additive change
  while this branch was open). The four SDK clients gain a `webhook` resource
  (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/sdk@0.7.0

## 0.3.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
  - @cat-factory/sdk@0.6.1

## 0.3.0

### Minor Changes

- a8acd48: Bring the published MCP server under the repo's publish guards and give it the protocol depth the
  generator already had the data for.

  The tool table now declares an `outputSchema` for every operation that answers with a JSON object and
  returns `structuredContent` beside the text, so a host or agent framework can consume a result without
  re-parsing prose. Those schemas are rendered deliberately loosely (no `required`, no `enum`, no closed
  `anyOf`, no bounds, and for a union not even `type`): a caller's MCP client validates against them and
  `/api/v1` is additive forever, so anything stricter would let an older copy of this package reject a
  newer deployment's honest answer. `destructiveHint` / `idempotentHint` are now set on the operations whose consequence is real
  money or a merged pull request, and left unset elsewhere so the protocol's cautious defaults stand.

  Two behaviour changes to know about:

  - **A result over `CAT_FACTORY_MCP_MAX_RESULT_CHARS` is now refused rather than truncated**, with a
    message naming the size, the limit and the way out (`limit` / `cursor` / `offset`, or a bigger cap).
    Half an object cannot satisfy the output schema it was cut out of, and the old `[TRUNCATED]` prefix
    spent the whole cap delivering the instruction to narrow instead of reading on.
  - **Results are compact JSON**, not two-space indented.

  New configuration: `CAT_FACTORY_API_KEY_FILE` reads the key from a file instead of the host's
  plaintext config (setting both is refused, not resolved by precedence), and
  `CAT_FACTORY_MCP_TOOLS` / `CAT_FACTORY_MCP_EXCLUDE_TOOLS` filter per tool beside the existing group
  filter, so withholding the PR-merging `notifications_act` no longer costs the whole inbox group. Every
  filter is stated in the server's instructions, and a combination that would expose no tools at all
  fails at startup.

## 0.2.1

### Patch Changes

- Updated dependencies [10e0341]
  - @cat-factory/sdk@0.6.0

## 0.2.0

### Minor Changes

- 43fd5c0: Add `@cat-factory/mcp-server`: a Model Context Protocol facade over the public API, so an MCP host
  can drive a workspace directly (plan work on the board, start and watch runs, answer parked
  decisions, read a run's telemetry).

  It is a facade rather than a fifth client. The tool table is rendered by `pnpm gen:sdk` from the
  same `docs/openapi.json` the four SDKs are generated from, and every tool is one call on
  `@cat-factory/sdk` — so it cannot drift from the surface it exposes, and it re-implements none of
  the SDK's auth, retry, error, pagination or encoding behaviour. `pnpm check:sdk` covers it.

  Every operation is a tool except the two SSE endpoints: a tool call returns one result over no
  streaming channel, and a bounded "wait for the run" tool would be a timeout dressed up as an
  answer, since a parked run waits for a human indefinitely by design. The server names both
  omissions, and their alternatives, in its instructions; generation fails on a new streaming
  operation nobody has classified.

### Patch Changes

- @cat-factory/sdk@0.5.0
