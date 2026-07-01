---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Mothership mode: mint the machine token from a whitelisted login and cache it locally, so
`LOCAL_MOTHERSHIP_TOKEN` is now a headless/CI override instead of a hard requirement.

A mothership (either facade) serves `POST /auth/machine-token`, which exchanges the caller's
mothership SESSION for a `machine`-audience token scoped to the user's accounts (derived from
`accountService.listForUser`; a `requestedAccountIds` hint may only NARROW that set, never widen
it). The single production mint helper `mintMachineToken` (`@cat-factory/server`) replaces the
hand-rolled test copy.

The local facade adds a `node:sqlite` machine-token cache and a local-only
`POST /local/mothership/connect` proxy: the SPA signs the user into the mothership (OAuth),
captures the returned session from the redirect fragment, and hands it to its own node, which
exchanges it for the opaque machine token (cached locally), mints a LOCAL session for the same
user, and returns it so the SPA is signed in. `composeMothership` now resolves the token per
request (env override → unexpired cached token → none), so a token-less node boots inert and the
SPA can drive the login rather than the boot throwing. The login screen gains a "Sign in via
mothership" affordance behind `localMode.mothership` (i18n across all locales).

A mothership now honours a post-login `redirect` back to a loopback host (`localhost`,
`127.0.0.0/8`, `::1`) in `pickPostLoginRedirect`, so the "Sign in via mothership" round-trip lands
back on the local node without an operator allowlisting every dev port (a redirect to the caller's
own machine is not a token-exfiltration vector). A failed connect exchange now surfaces an error on
the login screen instead of silently returning to the sign-in button, and each connect lets the
mothership assign the node id (a reconnect as a different user never inherits the previous user's
id).

Config: `AUTH_MACHINE_TOKEN_TTL_MS` (default 30 days) sets the machine-token lifetime on both
facades.
