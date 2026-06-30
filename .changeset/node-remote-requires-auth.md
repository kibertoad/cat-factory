---
'@cat-factory/node-server': minor
---

Remote node mode now requires authentication from the first request — there is no
anonymous tier. `loadNodeConfig` fails fast at boot when no login provider is configured
(GitHub OAuth, Google OAuth, or password login with a 32+ char `AUTH_SESSION_SECRET`) and
the `AUTH_DEV_OPEN` test hatch is off, instead of silently leaving auth disabled and
503-ing every protected route (a confusing half-brick that read like a bug rather than a
misconfiguration).

Breaking: a hosted node deployment that previously booted with no auth provider configured
(serving a fail-closed 503-only API) will now refuse to start until a login provider is
configured. Local mode is unaffected (`applyLocalDefaults` always enables password login),
and tests/CI continue to opt into `AUTH_DEV_OPEN` in a non-production environment.

Because auth is mandatory in remote node mode, the SPA's existing auth gate forces the
login screen before the app can render, so no separate front-end guard is needed for the
credentials/subscriptions window.
