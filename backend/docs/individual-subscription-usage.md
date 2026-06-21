# Individual-usage subscriptions (Claude)

> **Read this before connecting a personal Claude subscription.** Anthropic's consumer
> Claude (Pro/Max) subscription is licensed for **individual use only**. cat-factory
> enforces that licensing with a dedicated, per-user mode — it is deliberately *not* the
> shared workspace token pool the commercial coding-plan vendors use. This page is the
> source of truth for the model, the request flow, and the safeguards.

See also: [`model-support.md` §6](./model-support.md) (where this fits in the model
catalog), and [`SUBSCRIPTION_VENDORS`](../packages/kernel/src/domain/models.ts) (the
`individualOnly` flag that triggers this mode — today only `claude`).

---

## 1. Why a separate mode

The commercial coding-plan vendors (GLM, Kimi, DeepSeek, ChatGPT/Codex) sell keys meant
to be used by a team, so cat-factory pools them per workspace and rotates them
([`ProviderSubscriptionService`](../packages/integrations/src/modules/providers/ProviderSubscriptionService.ts)).

A personal Claude subscription is different: it is licensed to **one person**. Pooling it
on a workspace — where any member's runs could draw on it — would violate that license.
So a vendor flagged `individualOnly` is:

- **refused from the workspace pool** entirely (`addToken`/`leaseToken` → `409`), and
- **stored per-user** instead, usable only by that user's own runs.

This is the **individual-usage restricted mode**.

## 2. Safeguards (what protects the credential)

This mode is built so that **only the owning user can cause their Claude credential to be
used**, and so the stored credential is hard to misuse even by an operator with database
access. The safeguards, in layers:

1. **Per-user ownership.** A personal subscription is keyed by the GitHub **user id**. A
   run records its **initiator** (`ExecutionInstance.initiatedBy`); the container executor
   leases *that user's* credential, never another user's, and never a workspace-shared one.

2. **Double encryption at rest.** The token is sealed twice:
   `system.encrypt( personal.seal(token, password) )`.
   - The inner layer ([`WebCryptoPersonalSecretCipher`](../packages/server/src/crypto/WebCryptoPersonalSecretCipher.ts))
     derives an AES-256-GCM key from the user's **personal password** via PBKDF2
     (210k iterations). **The password is never stored**, anywhere.
   - The outer layer is the system `SecretCipher` (the `ENCRYPTION_KEY` master key).
   - Recovering the raw token therefore needs **both** the system key **and** the user's
     password. An operator with the database and the system key still cannot read it.

3. **Password supplied per session, not stored server-side.** The user types their
   password to start/retry a run. The browser caches it locally (localStorage, ~8h TTL)
   so it usually rides along transparently, then re-prompts. Caching it in the browser
   does not weaken at-rest protection — the server never has it, so the cache only helps
   on the device the user is already signed in on.

4. **Short-lived, per-run activations.** A password unlock mints a **per-run activation**
   (`subscription_activations`): the raw token re-encrypted with the **system key only**,
   scoped to that one run (`executionId`), so the run's asynchronous container steps can
   authenticate without the user staying online. Activations:
   - are **deleted the moment the run finishes** (terminal `done`/`failed`), and
   - have a TTL (~1 week) swept on a timer as a backstop,
   so the system-encrypted copy never lingers.

5. **No unattended use.** A **recurring schedule** whose block uses a Claude model is
   refused at fire time — there is no one present to unlock it, so it must not run
   silently on someone's subscription.

6. **Loud, recoverable failures.** If a run needs the credential and the password isn't
   available, the API replies `428 credential_required` (with `{ vendor, reason }`) so the
   client can prompt; if an activation has lapsed mid-run the step fails clearly and a
   retry (with the cached/entered password) re-activates it.

7. **Renewal awareness.** A subscription's own `expiresAt` is stored; the UI warns in
   advance and a lapsed subscription is blocked from unlocking until renewed.

## 3. Request flow

```
Connect (once):
  POST /personal-subscriptions { vendor:'claude', label, token, password, expiresAt? }
    → personal.seal(token, password) → system.encrypt(...) → personal_subscriptions row

Start / retry a Claude-pinned task:
  POST /workspaces/:ws/blocks/:id/executions { pipelineId, password? }
    │  individualVendorForBlock(block) === 'claude' ?
    │    ├─ no signed-in user / no stored subscription / no password
    │    │     → 428 credential_required { vendor, reason } → client prompts
    │    └─ password ok → activateForRun(execId, user, 'claude', password)
    │            → system.encrypt(rawToken) → subscription_activations row (TTL ~1wk)
    └─ run starts, recording initiatedBy = user

Each async container step:
  ContainerAgentExecutor → leasePersonalSubscriptionToken(execId, user, 'claude')
    → system.decrypt(activation) → raw token handed to the runner transport

Run finishes (done/failed):
  ExecutionService.emitInstance → subscriptionActivations.deleteByExecution(execId)
  (TTL sweep reclaims any stragglers: Worker cron / Node retention timer)
```

## 4. Where it lives (per the runtime-symmetry rule)

| Concern | Location |
| --- | --- |
| Wire contracts | [`contracts/personal-subscriptions.ts`](../packages/contracts/src/personal-subscriptions.ts) |
| Ports | [`kernel/ports/personal-subscription-repositories.ts`](../packages/kernel/src/ports/personal-subscription-repositories.ts), [`personal-secret-cipher.ts`](../packages/kernel/src/ports/personal-secret-cipher.ts) |
| Service | [`integrations/.../PersonalSubscriptionService.ts`](../packages/integrations/src/modules/providers/PersonalSubscriptionService.ts) |
| Password cipher | [`server/crypto/WebCryptoPersonalSecretCipher.ts`](../packages/server/src/crypto/WebCryptoPersonalSecretCipher.ts) |
| HTTP | [`server/.../PersonalSubscriptionController.ts`](../packages/server/src/modules/providers/PersonalSubscriptionController.ts), [`personalCredentialGate.ts`](../packages/server/src/modules/providers/personalCredentialGate.ts) |
| Executor lease | [`server/agents/ContainerAgentExecutor.ts`](../packages/server/src/agents/ContainerAgentExecutor.ts) |
| Persistence — Cloudflare | D1 migration `0039`, `D1PersonalSubscriptionRepository` / `D1SubscriptionActivationRepository` |
| Persistence — Node/local | Drizzle `personalSubscriptions` / `subscriptionActivations` + generated migration |
| Sweeps | Worker `scheduled` (activation sweeper) ⇄ Node retention timer |
| Frontend | `stores/personalSubscriptions.ts`, `components/providers/PersonalSubscriptionSection.vue` + `PersonalCredentialModal.vue` |

Both runtimes wire the same repositories + service behind the same ports, so the behaviour
is identical on Cloudflare D1 and Node/local Postgres.

## 5. Your responsibilities as a user

- Connect **only your own** Claude subscription, and only where its terms permit.
- Use a **strong personal password** — it is the second factor that protects your token at
  rest, and it is never recoverable from the server if you forget it (re-connect instead).
- Don't pin Claude models on tasks meant to run **unattended** (recurring schedules reject
  them by design).
