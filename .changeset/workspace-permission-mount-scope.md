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
empty list. A prefix may carry params, which is how the four controllers whose routes hang off a shared
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

**Prefixes trade the wildcard's over-reach for a possible under-reach, and that needs its own assertion.**
Deriving the expectation from the same prefix list is what makes the test above cheap, and it is also what
bounds it: omitting a prefix moves the expectation and the observation together, so it passes. Dropping
`/tasks` from `taskSourceController` leaves `POST /tasks/link` and `POST /tasks/create-block` answering to
the member floor with every assertion green, and `defineWorkspaceRbacSuite` cannot cover for it because it
drives ONE representative write per controller and so misses any SECOND prefix by construction. So a second
assertion states the complement structurally, without consulting the composed app: once a controller mounts
any gate, every route it serves must be covered by one of its OWN prefixes (writes always, reads too on the
`IncludingReads` variant). Its one escape hatch, `MEMBER_TIER_WRITES`, names the five deliberate
`documentSource` tier-split writes as routes rather than waiving the controller wholesale, and a row that
matches no route fails too, so the hatch cannot rot into a standing pre-approval. A third assertion refuses
a declared prefix matching none of the controller's routes, which is dead config that reads as protection.

**One behaviour change beyond the fix: `GET /workspaces/:ws/vcs/connect-options` is now admin-only.** That
controller serves exactly one route and it is a GET, so the writes-only mount left `integrations.manage`
there enforcing nothing at all; it read as a gate only because the wholesale `'*'` mount it shared did
refuse callers, on sibling controllers' routes rather than its own. Its own doc comment, and the SPA store
test that models "a member without `integrations.manage`", both already described the refusal, so it moves
to `mountWorkspacePermissionIncludingReads` and joins the cross-runtime gated-read case beside the
capability-credential and tool-server reads. A member now gets a 403 where they got the option list;
`loadConnectOptions` already degrades that to an empty list, which renders as "no connect surface".

Otherwise no permission changed and no route gained or lost its own gate: every controller ends up
enforcing what it already documented. What changes is that a member can now do the member-tier things the
gates were never meant to touch.
