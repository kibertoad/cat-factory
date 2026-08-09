# MCP authorization: the SERVING side, engine design

> **Connecting a host is on the website**:
> [MCP Server → Connecting a host over OAuth](https://www.catfactory.ai/extend/mcp-server.html#connecting-a-host-over-oauth)
> owns what a person does, what the consent screen asks, what a deployment configures, and the two
> properties (no expiry, two approvals leave two keys) an adopter needs before relying on it.
>
> This page is what a change in THIS repository has to keep true. The mirror image, this platform
> as a CLIENT of someone else's MCP server, is [`mcp-tool-servers.md`](./mcp-tool-servers.md).

The hosted endpoint (`POST /api/v1/mcp`, [`public-api.md`](./public-api.md)) has always accepted a
public-API key. What it gained is the discovery chain a host walks when nobody has given it one, and
the authorization server at the end of that chain. The whole feature is four documents and three
endpoints, and its shape is decided by two facts: the credential a host ends up with is the
credential the surface already authenticates, and every value the flow carries between two requests
is SEALED rather than stored.

## The chain, and why each link is where it is

| Link                           | Served by                                           | Fails as                                                       |
| ------------------------------ | --------------------------------------------------- | -------------------------------------------------------------- |
| `WWW-Authenticate` on the 401  | `handleError`, from a challenge the MCP route set   | a host reporting a bad credential, with no way to obtain one   |
| Protected-resource metadata    | `McpAuthorizationController`, both well-known paths | a host that reads only the path it was built for               |
| Authorization-server metadata  | the same controller                                 | a host with an issuer and no endpoints                         |
| Registration, authorize, token | the same controller, over `McpAuthorizationServer`  | a protocol refusal a client can act on, or a 503 naming wiring |

Four properties of that chain are load-bearing.

- **The challenge is the ENTRY POINT, and it is the piece with no second source.** Everything below
  it is discoverable only if a client is told to look, and a bare 401 says only that the credential
  was wrong. It is set on the CONTEXT by the route (`c.set('bearerChallenge', …)`) and rendered by
  `handleError`, which stays the one producer of the envelope: the route knows its challenge before
  it knows whether it will refuse, and the refusal is raised deep inside shared key-authentication
  code that has no business knowing which surface it is protecting. It is emitted on the 401 alone.
  RFC 6750's `insufficient_scope` challenge belongs on a refusal this endpoint cannot produce: it
  gates on `read`, the floor of an inclusive ladder, so a scope refusal comes from the `/api/v1`
  route a tool reaches afterwards, not from here.
- **`WWW-Authenticate` is in `CORS_EXPOSED_HEADERS`.** A browser-hosted client cannot read it
  otherwise, which is the one client that cannot connect without it.
- **Both well-known paths answer.** RFC 9728 INSERTS the resource path
  (`/.well-known/oauth-protected-resource/api/v1/mcp`); several shipped clients ask for the bare
  path. This deployment serves exactly one protected resource, so there is no second document either
  could mean. Figma's live server answers both too, which is where the choice came from.
- **The metadata documents are the ONE place the endpoint paths are stated**
  (`metadataDocuments.ts`, in `@cat-factory/integrations` rather than the controller). They live
  beside the consuming walk deliberately: `mcpAuthorizationInterop.test.ts` drives the CONSUMING
  discovery client over the SERVING documents, so the two halves are asserted against each other
  instead of each against a hand-written expectation that agrees with nothing.

## The three sealed values, and what a table would have cost

`McpAuthorizationServer` persists nothing. Each step turns one sealed value into the next, all under
one HKDF tag with an explicit `kind` the opener pins (so a value minted for one purpose cannot be
opened as another, the same discipline the consuming side's `state` uses):

- **`client_id` IS the registration** (name plus registered redirect URIs). Dynamic registration
  (RFC 7591) is what lets a host nobody configured connect at all.
- **The authorization request** carries the client, the redirect URI ALREADY matched against that
  registration, and the PKCE challenge, so nothing downstream re-derives them from what a browser
  presents.
- **The code** carries all of that plus what the human approved: the board, the scope, and who
  approved it.

A table would have cost a migration on both runtimes, a repository pair, a mothership routing
decision, and a sweeper on both facades for the rows behind every consent screen anyone abandoned.
Sealing costs two properties instead, and both are stated rather than hidden:

- **No single-use enforcement on the code.** PKCE is what makes that survivable: redeeming needs the
  verifier, which never left the host, so a code captured from a history, a referrer or a proxy log
  is unredeemable by whoever captured it. What remains is a legitimate host redeeming its own code
  twice and getting two keys its user already approved. The TTL is 60 seconds.
- **No revocation of a registration.** A registration confers nothing on its own: no scope, no
  board, no token, not even the ability to ask again, until a signed-in human with `secrets.manage`
  approves a specific board. What that human approves is a key they can see and revoke.

## The token is a public-API key, and that decides the rest

The token endpoint mints through `PublicApiKeyService`, labelled `MCP: <client name>` with
`externalIdentity` naming the host. Three consequences follow, and a change here must keep all three:

- **Nothing downstream learns a second token format.** No new bearer parse, no change to
  `publicApiAuth`, and every `/api/v1` route the tools reach is authenticated exactly as before.
- **Revocation is the button that already exists**, in the board's key panel, and it kills the
  host's access in one place.
- **`expires_in` is ABSENT, and no refresh grant is advertised.** The key does not expire, so a
  stated lifetime would be a lie and a refresh grant could only mint duplicates. RFC 6749 makes
  `expires_in` optional precisely so a server says this by omission. Giving keys a real expiry is
  the change that would make a refresh grant honest, and it needs an `expiresAt` column on both
  runtimes; until then, do not advertise one.

## Where the human is, and why the flow detours through the SPA

`GET /oauth/authorize` validates and then REDIRECTS to `/mcp-authorize` in the app, which re-presents
the sealed request over two session-gated calls (`describe`, `decision`). This is the same shape the
consuming side's vendor callback settled on, arrived at from the opposite direction: an authorization
endpoint is a top-level browser navigation a third party triggers, so it carries no bearer token, and
a consent screen rendered there could not say who was approving. Any "is this the right person"
check written on such a route is unreachable code that reads like protection.

So the gates that actually run are: the shared default-deny session gate, the sealed request (only
this deployment can mint or open one, and it expires in 15 minutes), and `secrets.manage` on the
board the human PICKED, resolved through the one shared `loadWorkspaceAccess` at the moment of
approval. It cannot be the workspace gate: the board arrives in the body, because choosing it is
what the screen is for.

Two asymmetries in that controller are deliberate:

- **A DENIAL takes no permission.** Anyone who can open the screen may decline. Requiring
  `secrets.manage` to say no would leave a person who cannot approve unable to answer at all, so the
  host waits out its timeout instead of being told.
- **An unregistered `redirect_uri` is refused ON THE PAGE, never bounced to.** Reporting that one by
  redirecting would BE the open redirect the registration check exists to prevent: a URL on this
  deployment's origin that forwards a browser anywhere, with attacker-chosen text on the end of it.
  Every other refusal at the authorize endpoint is the client's to hear about, and RFC 6749 §4.1.2.1
  requires it: a bad `response_type`, a missing PKCE challenge or a `resource` naming somewhere else
  leave a conforming host waiting on a callback that never arrives, so what it finally reports is a
  timeout against this deployment rather than the one parameter it got wrong.

  **Which of the two a refusal is, is the SERVICE's judgement and rides the error**
  (`McpOAuthRedirectableError`, carrying the already-matched target). The line is
  `beginAuthorization`'s registration check: before it, there is no address the refusal may be sent
  to; after it, the address is one the client itself registered. A controller re-deciding that from
  the request would be re-deriving, from attacker-supplied input, the one thing this flow may not
  get wrong.

- **The consent screen never preselects a scope the HOST asked for above the platform default.**
  Registration is unauthenticated, so `scope=admin` costs an attacker nothing, and the ask arriving
  as the checked radio button would make the rung that deletes tasks and merges pull requests the
  default on a screen whose whole subject is a grant. `consentDefaultScope` honours the ask only
  DOWNWARD (nothing is protected by talking someone into granting `read`); above the default it
  preselects the default and the view carries `requestedScope` beside it, so the screen SAYS what
  was asked and raising it stays something a person does.

## Refusals answer in OAuth's vocabulary

`McpOAuthProtocolError` carries the protocol's own code and the controller renders RFC 6749 §5.2's
`{ error, error_description }` at the status the protocol assigns (`invalid_client` 401, everything
else 400). This is the same split the hosted MCP endpoint already makes between an HTTP-level auth
failure (the deployment's envelope, correlation id and all) and a protocol-level refusal answered in
the transport's own frame: `invalid_grant` and `invalid_client` are both a bare `validation` in the
envelope's vocabulary, and the distinction is exactly what a client branches on. Anything that is
NOT a protocol error is re-thrown to `handleError`, so an unexpected fault keeps its 500 and its
correlation id rather than being flattened into a code no client can act on.

The one `DomainError` deliberately translated rather than rethrown is the per-board key cap, and it
is translated because of WHERE it lands: `redeemCode` mints the key, so the cap refuses after the
human approved and after the browser went back to the host, on a machine-to-machine call where
`error_description` is the only thing left that reaches a person. A 409 envelope there is a shape no
OAuth client parses, so the host reports a broken connection and names nothing to act on.

## The unauthenticated paths answer any browser origin

`/.well-known/*` and `/oauth/*` are exempt from `CORS_ALLOWED_ORIGINS` (`isPubliclyReadablePath`,
in the shared CORS layer both facades read). That is the complement of the allowlist rather than a
hole in it: the allowlist names the origins that may drive an EXISTING credential's surface, and
every route under these two prefixes is reached by a party with no credential and no relationship to
this deployment, which is what it came for. The hosts the feature exists for run on origins no
operator can be expected to have listed, and an attacker reads these documents from a server with no
browser involved, so a per-deployment allowlist here restricts only the legitimate client.

It is a PATH rule in the CORS layer rather than a header on the metadata handlers because **the
browser asks first**: `POST /oauth/register` carries JSON, so it is preflighted, and a preflight is
answered before any route runs. Covering the documents alone reads as working, because discovery is
a plain GET nobody preflights: a browser host walks the whole chain and then fails on the first call
that acts on it.

The documents are also GATED on the capability, so a deployment that wired neither `ENCRYPTION_KEY`
nor the public API advertises nothing. A signpost pointing at a road that 503s is worse than no
signpost: a host that reads discovery believes the flow is available and reports a broken server,
where a host that cannot discover falls back to asking for a key, which is the behaviour that
existed before any of this.

## What a deployment needs, and what absence means

`mcpAuthServerContainerFields` builds the server only when BOTH hold: an `ENCRYPTION_KEY` (every
carried value is sealed under it) and the public-API key store (what the flow issues). Absent, every
route refuses with a 503 naming both, which is the honest answer for a capability a deployment has
not enabled. `APP_BASE_URL` is read only for the consent redirect and falls back to the request's own
origin, which is right for every same-origin install; unlike the consuming side's
`MCP_OAUTH_REDIRECT_URL`, no third party holds this string, so it can differ between deployments
without breaking anything.

Both facades project the same fields through that one helper, so a facade cannot wire half of it.
