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
use only (Anthropic's consumer Claude subscription). Such vendors are no longer
poolable on a workspace; instead each user stores their OWN credential and only that
user's runs may use it.

- **Per-user, double-encrypted storage.** A personal subscription's token is sealed
  under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
  stored) and then encrypted again with the system key, so it cannot be recovered
  without BOTH the system key AND the password. New `personal_subscriptions` table on
  both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
  `GET/POST/DELETE /personal-subscriptions` (user-scoped).
- **Per-run activation.** At task start/retry the user supplies their password (the
  client caches it locally with a TTL so it usually rides along transparently) to mint
  a short-lived, system-encrypted, per-run activation (`subscription_activations`
  table) that the asynchronous container steps lease — so the whole step chain
  authenticates without the user present. Activations are deleted when the run finishes
  and swept on TTL expiry.
- **No recurring runs.** A recurring schedule whose block uses an individual-usage
  model is refused at fire time (it can't be unlocked unattended).
- **Gating.** Starting/retrying a run on a Claude-pinned block requires a signed-in
  user with a stored subscription; a missing password returns `428 credential_required`
  so the client prompts. The container executor leases the initiator's activation and
  fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.
