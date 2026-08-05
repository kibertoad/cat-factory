---
'@cat-factory/server': minor
---

Fix: an admin controller's permission gate refused every sibling controller's writes, so members were 403'd on the human gates

Each admin controller gated itself with `app.use('*', requireWorkspacePermission(perm))`. That reads as
"this controller", and it is not: `app.route('/workspaces/:workspaceId', sub)` re-registers a sub-app's
`use('*')` as `ALL /workspaces/:workspaceId/*` on the SHARED app, and Hono runs a matching middleware for
every route registered after it. So each of those mounts also gated every sibling controller registered
later in `app.ts`, and 985 route entries followed the first one.

The consequence was not theoretical. The admin document and task-source controllers are registered ahead
of the human-gate controllers, so a plain `member` on an auth-enabled, RBAC-scoped deployment was refused
their own review decisions, requirement-review answers and initiative writes, with
`"This action requires the integrations.manage permission"`. That is the product's core loop. It stayed
invisible because an account admin (and an account owner) resolves as a workspace `admin`, which is who
develops and demos, and because no test drove a member through a HITL route.

Every gate now mounts on its own controller's top-level path prefixes through one helper,
`mountWorkspacePermission(app, permission, prefixes)`, which pairs each prefix with its `/*` subtree
(Hono's `*` does not match the bare prefix, a trap each hand-rolled mount had to remember) and refuses an
empty list. A prefix may carry params, which is how the three controllers whose routes hang off a shared
first segment (`/services/:blockId/test-secrets`, `/services/:blockId/validation-checks`,
`/blocks/:blockId/environment-test`, `/frames/:frameId/preview`) gate their own routes without claiming
the segment. No gate middleware factory is exported from `workspaceAccess.ts` any more, so the wildcard
mount is unrepresentable rather than merely discouraged.

`app.ts` now mounts the per-workspace and per-account APIs from two ordered lists
(`WORKSPACE_CONTROLLERS`, `ACCOUNT_CONTROLLERS`) rather than from two runs of `app.route` calls, because
registration order is the load-bearing fact here and a guard can only judge a list. The order is
byte-for-byte what it was.

`http/permissionMounts.test.ts` pins the invariant on the REAL composed app, with a real member's resolved
access: **a member is refused exactly the writes their own controller gates, and no others.** Expectations
are derived rather than tabulated. The controller list is the one the app mounts from, each controller is
also built standalone so its own tagged gate entries say which of its routes it means to refuse, and a
third assertion fails if the app mounts a gate no listed controller produces, so the derivation cannot
quietly cover less than the app serves. Verified by re-introducing a wholesale mount: it names the exact
sibling routes that get shadowed.

No permission changed, and no route gained or lost its own gate: every controller ends up enforcing what
it already documented. What changes is that a member can now do the member-tier things the gates were
never meant to touch.
