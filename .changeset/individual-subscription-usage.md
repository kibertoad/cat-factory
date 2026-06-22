---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
'@cat-factory/app': minor
---

Add an **individual-usage restricted mode** for subscriptions licensed for personal
use only (`claude`, `glm` and `codex` — see their terms of service). Such vendors are no
longer poolable on a workspace; instead each user stores their OWN credential and only
that user's runs may use it.

- **Per-user, double-encrypted storage.** A personal subscription's token is sealed
  under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
  stored) and then encrypted again with the system key, so it cannot be recovered
  without BOTH the system key AND the password. New `personal_subscriptions` table on
  both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
  `GET/POST/DELETE /personal-subscriptions` (user-scoped).
- **One password per user.** All of a user's individual-usage subscriptions must share a
  single personal password (enforced at store time), since a run unlocks every vendor it
  touches with one password. Passwords are restricted to printable ASCII so they are
  HTTP-header-safe.
- **Per-run activation, short TTL, transparently extended.** At task start/retry the user
  supplies their password — carried on the ambient `X-Personal-Password` header (never a
  body field), cached client-side (~8h) so it usually rides along transparently — to mint a
  short-lived (~12h), system-encrypted, per-run activation (`subscription_activations`
  table) that the asynchronous container steps lease, so the whole step chain authenticates
  without the user present. The activation is **re-minted from the cached password on each
  interaction** (resolve a decision / approve a step / retry), so an actively-tended run
  never lapses under the short TTL; the user is only re-prompted once the password cache
  expires. Activations are deleted when the run finishes (or its block's run is replaced)
  and swept on TTL expiry.
- **No recurring runs.** A recurring schedule whose block resolves to an individual-usage
  model — by pin **or** workspace per-kind default — is refused at fire time (it can't be
  unlocked unattended).
- **Gating.** Starting/retrying a run that resolves to individual-usage model(s)
  requires a signed-in user with the stored subscription(s); a missing password returns
  `428 credential_required` so the client prompts. The gate mirrors dispatch's model
  precedence (block pin → workspace per-kind default) across the pipeline's steps, so a
  block with no pin but an individual-usage workspace default is gated up-front instead
  of failing at dispatch. The container executor leases the initiator's activation and
  fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

**Breaking (no migration — backwards compatibility is a non-goal here):** `glm` and `codex`
join `claude` as individual-only, and individual-only vendors are no longer poolable on ANY
workspace. Any existing **pooled** `claude`/`glm`/`codex` workspace tokens become orphaned
(no longer leased or listed) — reconnect them as personal subscriptions.

See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.
