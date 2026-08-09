---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/node-server': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
---

Let an MCP host connect over OAuth, instead of being handed a key to paste into a config file.

The hosted endpoint (`POST /api/v1/mcp`) has always accepted a public-API key, and a key was the only
way in. That rules out the hosts the endpoint exists for: claude.ai, Claude Desktop and the IDE
clients discover authorization from the server and have no console at someone else's deployment to
paste a credential into. It also puts a long-lived credential in a config file on disk, which is the
exact hazard this project's own docs warn about for the stdio path.

This deployment now speaks the MCP authorization spec, as its own authorization server. A host asks
the endpoint, is answered `401` with a `WWW-Authenticate` naming the protected-resource metadata,
walks that to the authorization-server metadata, registers itself dynamically, and opens a browser.
A signed-in person with `secrets.manage` picks the board and the rung of the scope ladder, and the
host is issued a credential of its own.

**What it issues is an ordinary public-API key**, and that one choice decides most of the rest.
Nothing downstream learns a second token format, every `/api/v1` route the tools reach authenticates
exactly as before, and revoking the connection is the button already in the board's key panel, where
it appears as `MCP: <host name>`. The honest cost is stated on the wire rather than hidden: a key
does not expire, so `expires_in` is OMITTED (RFC 6749 makes it optional precisely so a server can say
this by absence) and NO refresh grant is advertised, because a refresh could only mint duplicates. A
client asking for one is refused in the protocol's own vocabulary rather than by a 404 it would read
as a broken deployment. Giving keys a real expiry is what would make a refresh grant honest, and it
needs an `expiresAt` column on both runtimes.

**Nothing is persisted.** The `client_id`, the in-flight authorization request and the code are each
sealed into the value the other party carries, under the deployment's own key with an explicit `kind`
the opener pins. A table would have cost a migration on both runtimes, a repository pair, a
mothership routing decision, and a sweeper for the rows behind every consent screen anyone abandoned.
It buys two residual gaps, both recorded rather than papered over. There is no single-use enforcement
on the code, which PKCE makes survivable (redeeming needs the verifier, which never left the host, so
a code lifted from a history or a proxy log is unredeemable by whoever lifted it) and which a 60
second TTL bounds; and a registration cannot be revoked, which is acceptable because it confers
nothing at all until a human approves a specific board.

**Dynamic client registration IS performed here, the opposite of the decision on the consuming side**,
where this platform is the OAuth client of a vendor's MCP server and deliberately does not register
itself. There, a runtime-minted client is deployment state with no operator-visible identity at the
vendor, so nobody can find, rotate or revoke it. Here the registration is a name and a redirect list
that grant nothing until a `secrets.manage` holder approves a board and a scope, and what they
approve is a key they can see and delete.

**The consent screen is a page in the SPA, not a screen the backend renders**, which is the same
shape the consuming side's vendor callback settled on, reached from the opposite direction. An
authorization endpoint is a top-level browser navigation a third party triggers, so it carries no
bearer token, and a screen served there could not say who was approving; any "is this the right
person" check written on it is unreachable code that reads like protection. So `GET /oauth/authorize`
validates, seals, and redirects to `/mcp-authorize`, whose two calls are ordinary session-gated API.
On an SSO deployment that is also where the identity provider gets into a flow that otherwise knows
about nobody.

Two asymmetries in that controller are deliberate. A DENIAL takes no permission, because a person who
cannot approve must still be able to answer, or the host waits out its timeout and its user goes
looking for a fault in the deployment. And WHERE a refusal at the authorize endpoint goes turns on
one line: until the `redirect_uri` has been matched against the registration there is no address it
may be sent to, because bouncing it back would BE the open redirect that check exists to prevent, so
it renders as a page; once it has been matched, RFC 6749 §4.1.2.1 puts every remaining fault (a bad
`response_type`, missing PKCE, a `resource` naming somewhere else) on the client's own registered
address, because a page instead leaves a conforming host waiting on a callback that never arrives.
The distinction is carried by the error the service throws rather than re-derived at the route, so
nothing downstream re-decides it from attacker-supplied input.

**The consent screen preselects the platform's default scope, never the host's ask above it.**
Registration is unauthenticated, so `scope=admin` costs an attacker nothing, and an ask arriving as
the checked radio button would put the rung that deletes tasks and merges pull requests in front of a
person as though it were the shipped default. The ask is honoured only downward; above the default it
is REPORTED on the screen instead, so raising the grant stays something a person does.

**The 401 challenge is the piece with no second source.** Everything else in the chain was already
serveable and would have been unreachable, because nothing told a client to look. It is set by the
route on the request context and rendered by `handleError`, which stays the one producer of the error
envelope: the route knows its challenge before it knows whether it will refuse, and the refusal is
raised inside shared key-authentication code that has no business knowing which surface it protects.
`WWW-Authenticate` also joins `CORS_EXPOSED_HEADERS`, without which a browser-hosted client cannot
read the one header it cannot connect without.

**Verified against a real vendor rather than against expectations written beside the code.** The
serving documents are asserted by driving this repository's own CONSUMING discovery walk over them,
and the same test drives that walk over the documents Figma's live MCP server actually serves,
recorded verbatim. One client, two servers, and the second held to what the first demonstrates is
enough. The Figma fixture earns its place twice: it is also the only regression test the consuming
walk has against a shipping, OAuth-protected MCP server.

**`/.well-known/*` and `/oauth/*` answer any browser origin**, whatever `CORS_ALLOWED_ORIGINS` says,
through one predicate in the shared CORS layer both facades read. That is the complement of the
allowlist rather than a hole in it: the allowlist names the origins that may drive an existing
credential's surface, every route under these two prefixes is reached by a party that has no
credential yet, and the hosts this exists for run on origins no operator can be expected to have
listed. It belongs in the CORS layer rather than on a handler because a preflight is answered before
any route runs: covering the documents alone reads as working, since discovery is a plain GET nobody
preflights, and then the first call that ACTS on what was discovered is dropped by the browser.

Serving is enabled exactly when a deployment can complete the flow: an `ENCRYPTION_KEY` (everything
carried is sealed under it) and the public-API key store (what it issues). Absent either, NOTHING is
advertised: the discovery documents refuse with the same 503 as the routes they describe, and a host
falls back to asking for a key. A deployment that described an authorization server it cannot run
would send every host down a chain that fails at the last step, which reads as a broken deployment
rather than as one that has not enabled a capability.
`APP_BASE_URL` is read only for the consent redirect and falls back to the request's own origin,
which is right for every same-origin install; unlike the consuming side's `MCP_OAUTH_REDIRECT_URL`,
no third party holds this string.
