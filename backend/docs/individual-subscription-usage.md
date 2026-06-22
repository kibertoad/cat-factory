# Individual-usage subscriptions (Claude / GLM / ChatGPT-Codex)

> **Read this before connecting a personal subscription.** Some LLM subscriptions are
> licensed for **individual use only** — their terms forbid sharing one credential across
> a team or organization. cat-factory enforces that with a dedicated, per-user mode: such
> a vendor is **never** added to the shared workspace token pool; instead each user stores
> their OWN credential and only that user's runs may use it. This page is the source of
> truth for which vendors, why, the request flow, and the (honest) threat model.

See also: [`model-support.md` §6](./model-support.md) (where this fits in the model
catalog) and [`SUBSCRIPTION_VENDORS`](../packages/kernel/src/domain/models.ts) (the
`individualOnly` flag that triggers this mode).

---

## 1. Which vendors, and why (the terms of service)

The `subscriptionVendor` pool models exactly one thing: **sharing a single subscription
credential across a workspace's runs** (any member's run can lease any pooled token). A
vendor is flagged `individualOnly` — removed from that pool and routed to the per-user
flow below — when its own terms forbid that sharing. As of this writing:

| Vendor     | Credential                       | `individualOnly` | Terms (why)                                                                                                                                                                              |
| ---------- | -------------------------------- | :--------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`   | `claude setup-token` OAuth token |     **yes**      | Anthropic consumer Claude (Pro/Max) is for individual use only.                                                                                                                          |
| `glm`      | Z.ai GLM Coding Plan API key     |     **yes**      | Z.ai: the Coding Plan "is licensed only to the individual natural person" and you "shall not … allow any other person (including … any organization) to use your GLM Coding Plan quota." |
| `codex`    | ChatGPT `auth.json`              |     **yes**      | OpenAI prohibits credential sharing; a ChatGPT subscription is per-seat (Plus/Pro are individual-use; Team/Business/Enterprise just grant more individual seats — each its own login).   |
| `kimi`     | Moonshot coding-plan API key     |        no        | Moonshot's terms **explicitly permit** enterprise use ("if the account is used for enterprise, you must ensure that you have authorization from the business").                          |
| `deepseek` | DeepSeek API key                 |        no        | A commercial API platform whose terms contemplate serving internal/external end users.                                                                                                   |

### Doesn't this depend on the license _tier_?

No — and this is the key reason the flag lives on the **vendor**, not on a per-credential
"tier" field:

- A **subscription credential is tied to one individual seat at every tier.** ChatGPT
  Team/Business/Enterprise don't make a _shared_ credential; they hand out more individual
  seats, each with its own login and its own `auth.json`. Sharing one member's credential
  across a workspace breaches the terms _at the enterprise tier too_.
- The legitimate **org-wide / programmatic** path is **API keys**, which cat-factory
  already serves through the **direct-provider key path** (`OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` / the dual-mode keys in [`model-support.md` §7](./model-support.md)).
  That path is completely unaffected by `individualOnly`.

So flagging a vendor here does **not** lock organizations out — it routes them to API
keys, which is the correct mechanism for shared access. A self-declared "tier" field would
add unverifiable complexity (we can't confirm a tier from a token) and would risk
_licensing a violation_ under an "enterprise" label that no consumer tier actually permits.
If a genuine need ever appears to pool an org-licensed credential, the right design is an
explicit per-credential **attestation** ("my license permits shared use") — a deliberate
opt-out of the safe default — not tier inference.

## 2. Why a separate mode

The poolable vendors are stored in a per-workspace pool and rotated
([`ProviderSubscriptionService`](../packages/integrations/src/modules/providers/ProviderSubscriptionService.ts)).
An `individualOnly` vendor is instead:

- **refused from the workspace pool** entirely (`addToken`/`leaseToken` → `409`, and
  `hasToken` → always `false` so the executor's "subscriptions always win" routing never
  auto-selects a vendor a lease would reject), and
- **stored per-user**, usable only by that user's own runs.

This is the **individual-usage restricted mode**. The rule is **account-agnostic**: these
vendors are never poolable on _any_ workspace (personal or org). The org case is just the
one it matters most for — pooling an individual-use credential across an org is the most
likely accidental breach — and the cross-runtime conformance suite asserts the rejection
against an org-owned workspace.

## 3. What this protects against (the honest threat model)

It helps to be precise about what the safeguards do and don't buy, so nobody over-trusts
them — and so the UI copy stays truthful.

**Goal.** Prevent the _accidental_ misuse of an individual-licensed credential, and make
it transparent that the system gives you **no easy way** to share one across a workspace.
We are **not** trying to defend against a malicious operator or a determined organization —
anyone who runs the deployment (and holds the system `ENCRYPTION_KEY`) could capture a
token regardless, and a user who _wants_ to share their credential always can. That is an
accepted non-goal.

**What the password layer actually buys.** The credential is double-encrypted —
`system.encrypt( personal.seal(token, password) )` — so recovering it at rest needs **both**
the system key **and** the user's password. The password layer's _only_ cryptographic
value is therefore against a holder of the **system key** (an operator/insider): without
the user's password they cannot read an at-rest personal credential. For _everyone else_ —
an external attacker, a DB leak, a curious workspace peer — the system layer alone already
suffices, because none of them have the system key. Since defending against the
system-key holder is an explicit non-goal, the password layer is best understood as a
**transparency signal + accidental-misuse prevention** mechanism (the system visibly makes
you unlock _your own_ credential, per run, so it can't silently pool it), not a wall
against insiders.

**Why this still has teeth for the real goal.** The architecture makes "your run uses
_your_ credential" true by construction: a run records its initiator, and the executor
leases activations keyed by `(executionId, userId, vendor)`. A workspace peer who triggers
a run becomes a _new_ run under _their_ id, so they are prompted for _their own_ password
and can never accidentally ride yours. There is no API that pools or shares these tokens.

**The client-side password cache.** To stay low-friction the typed password is cached in
the browser (`localStorage`, single key, ~8h TTL) so a start/retry usually rides along
transparently. This does **not** weaken at-rest protection: the server never stores the
password, and the cache is useless to an external attacker without the system key. It is a
convenience on the device the user is already signed in on. (An XSS attacker on the origin
who could read the cache could already act as the signed-in user — but still cannot recover
the raw token, which is never returned to the client.)

**The per-run activation TTL.** A password unlock mints a per-run activation: the raw token
re-encrypted with the **system key only** (no password layer), scoped to one run, so the
asynchronous container steps can authenticate without the user online. During that window
the token is recoverable with the system key alone — but that only matters to a system-key
holder, the actor we've descoped, and on a system-key compromise every _other_
system-encrypted secret (the whole pooled-subscription pool, GitHub/Slack tokens, …) is
exposed too, so a personal token in an active run is marginal incremental exposure. The TTL
(~1 week) is deliberately longer than a run needs so an actively-tended long run isn't
re-prompted; activations are **deleted the moment the run finishes** (so the common case is
much shorter than the TTL), refreshed on user interaction, and swept on expiry as a
backstop. Given the threat model, this is a fine trade-off — not a standing risk to anyone
we're trying to protect against.

## 4. Safeguards (summary)

1. **Per-user ownership.** Keyed by GitHub **user id**; a run records its **initiator** and
   the executor leases _that user's_ credential, never another user's or a pooled one.
2. **Double encryption at rest** (§3): `system.encrypt( personal.seal(token, password) )`,
   the password (PBKDF2 → AES-256-GCM, 210k iterations) never stored.
3. **Password supplied per session, not stored server-side** — cached client-side with a
   TTL for low friction (§3).
4. **Short-lived, per-run activations** — system-key-only, scoped to the run, deleted on
   completion (or when the block's run is replaced), TTL-swept as a backstop (§3).
5. **No unattended use.** A recurring schedule whose block resolves to an individual-usage
   model is refused at fire time (no one is present to unlock it).
6. **Loud, recoverable failures.** A missing/needed credential returns
   `428 credential_required` (with `{ vendor, reason }`); a lapsed activation fails the step
   clearly and a retry (with the cached/entered password) re-activates it.
7. **Renewal awareness.** A subscription's own `expiresAt` is stored; the UI warns in
   advance and a lapsed subscription is blocked from unlocking until renewed.

## 5. Request flow

```
Connect (once, per individual-usage vendor):
  POST /personal-subscriptions { vendor, label, token, password, expiresAt? }
    → personal.seal(token, password) → system.encrypt(...) → personal_subscriptions row

Start / retry a task whose run uses individual-usage model(s):
  POST /workspaces/:ws/blocks/:id/executions { pipelineId, password? }
    │  individualVendorsForBlock(ws, block, pipeline)  ── resolves the SET of
    │  individual-usage vendors the run will use, mirroring dispatch precedence
    │  (block pin → workspace per-kind default) across every pipeline step
    │    ├─ empty set → no personal credential needed (normal run)
    │    ├─ no signed-in user / no stored subscription / no password
    │    │     → 428 credential_required { vendor, reason } → client prompts
    │    └─ password ok → for each vendor: activateForRun(execId, user, vendor, password)
    │            → system.encrypt(rawToken) → subscription_activations row (TTL ~1wk)
    └─ run starts, recording initiatedBy = user

Each async container step:
  ContainerAgentExecutor → leasePersonalSubscriptionToken(execId, user, vendor)
    → system.decrypt(activation) → raw token handed to the runner transport

Run finishes (done/failed) — or is replaced by a new run on the block:
  ExecutionService deletes the run's subscription_activations immediately
  (TTL sweep reclaims any stragglers: Worker cron / Node retention timer)
```

The gate consults the workspace per-kind default model — not just the block's pin — so a
block with **no** pinned model whose workspace default resolves to an individual-usage
vendor is gated up-front, instead of starting and then failing at dispatch on a missing
activation. (Env-routing defaults, the last fallback, are operator-level and not gated.)

## 6. Where it lives (per the runtime-symmetry rule)

| Concern                  | Location                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor flag + helpers    | [`SUBSCRIPTION_VENDORS`, `isIndividualVendor`, `INDIVIDUAL_VENDORS`, `individualVendorForModelId`](../packages/kernel/src/domain/models.ts)                                                                                     |
| Wire contracts           | [`contracts/personal-subscriptions.ts`](../packages/contracts/src/personal-subscriptions.ts)                                                                                                                                    |
| Ports                    | [`kernel/ports/personal-subscription-repositories.ts`](../packages/kernel/src/ports/personal-subscription-repositories.ts), [`personal-secret-cipher.ts`](../packages/kernel/src/ports/personal-secret-cipher.ts)               |
| Service                  | [`integrations/.../PersonalSubscriptionService.ts`](../packages/integrations/src/modules/providers/PersonalSubscriptionService.ts)                                                                                              |
| Password cipher          | [`server/crypto/WebCryptoPersonalSecretCipher.ts`](../packages/server/src/crypto/WebCryptoPersonalSecretCipher.ts)                                                                                                              |
| HTTP + gate              | [`server/.../PersonalSubscriptionController.ts`](../packages/server/src/modules/providers/PersonalSubscriptionController.ts), [`personalCredentialGate.ts`](../packages/server/src/modules/providers/personalCredentialGate.ts) |
| Engine gate              | [`ExecutionService.individualVendorsForBlock/ForRun`](../packages/orchestration/src/modules/execution/ExecutionService.ts)                                                                                                      |
| Executor lease           | [`server/agents/ContainerAgentExecutor.ts`](../packages/server/src/agents/ContainerAgentExecutor.ts)                                                                                                                            |
| Persistence — Cloudflare | D1 migration `0039`, `D1PersonalSubscriptionRepository` / `D1SubscriptionActivationRepository`                                                                                                                                  |
| Persistence — Node/local | Drizzle `personalSubscriptions` / `subscriptionActivations` + generated migration                                                                                                                                               |
| Sweeps                   | Worker `scheduled` (activation sweeper) ⇄ Node retention timer                                                                                                                                                                  |
| Frontend                 | `stores/personalSubscriptions.ts`, `components/providers/PersonalSubscriptionSection.vue` + `PersonalCredentialModal.vue`                                                                                                       |

Both runtimes wire the same repositories + service behind the same ports, so the behaviour
is identical on Cloudflare D1 and Node/local Postgres.

## 7. Your responsibilities as a user

- Connect **only your own** subscription, and only where its terms permit individual use.
  For organization-wide use, use a **direct provider API key** instead (§1).
- Use a **strong personal password** — it is the second factor that protects your token at
  rest, and it is never recoverable from the server if you forget it (re-connect instead).
  If you connect more than one individual-usage subscription, use the **same** personal
  password (one run uses one password to unlock every individual-usage vendor it touches).
- Don't pin individual-usage models on tasks meant to run **unattended** (recurring
  schedules reject them by design).
