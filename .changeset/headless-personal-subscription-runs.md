---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/app': minor
'@cat-factory/acceptance': patch
---

A public-API key now has an IDENTITY as well as a scope: a SYSTEM token (the default, unchanged) or
a PERSONAL token its minter bound to themselves, which can run their own individual-usage
subscription headlessly. Surface version 1.45.0, additive. Plus two bug fixes that made the old
behaviour unreadable rather than merely limited.

**The reported problem.** A workspace whose Claude runs come from a stored personal subscription was
told by `GET /api/v1/models` that `claude-opus` was `available: false`, which the acceptance suite
rendered as "no provider wired for it". Both statements are false, and the remedy they imply (add a
provider key) is for a deployment that was already correct. The model was wired — as a credential
belonging to a person, which a key-authenticated read is not allowed to see.

**Two things were genuinely broken, independent of the feature.**

`resolveWorkspaceCapabilities` did not know about NATIVE ambient execution. A vendor served by the
host's own `claude`/`codex` CLI login (`LOCAL_NATIVE_AGENTS`) has no credential in either store, and
the resolver consulted only those two stores, so the catalog and the pipeline-start guard called the
model unconfigured on the very machine that would have run it. The personal-credential gate, reading
the same allow-list, had already decided such a vendor needs no unlock: two halves of one decision,
disagreeing. They now share `isAmbientNativeVendor`, which is where the executor's half already was.

`excludesUserScopedModels` covered only per-user locally-run endpoints, not personal subscriptions.
That flag exists precisely so "withheld from you" cannot read as "nothing is wired", and for the
commonest case it was silent. It now covers both, and is false for a token that had nothing withheld.

**The feature.** `POST /workspaces/:ws/public-api-keys` takes `actsAsSelf`, and the key row carries
`actsAsUserId`. A personal token's runs record that person as initiator, `GET /api/v1/models`
resolves under them, and a start/retry/decision call may unlock their subscription by sending
`X-Personal-Password` — the same header, the same 428, and the same per-run activation the app uses.
A system token behaves exactly as every key did before, including the `409
individual_model_unsupported` refusal, which is now reserved for the case no password could fix.

Three properties bound it, and each is a shape rather than a rule to remember. The wire field is a
BOOLEAN and the server reads the id off the session, so minting a key onto a colleague's
subscription is unrepresentable rather than merely forbidden; a mint with no signed-in user is
refused instead of quietly producing an unbound key. Headless provisioning (`POST /api/v1/keys`)
can never bind, because a provisioning key holds nobody's consent to inherit. And the password is
stored NOWHERE — not on the row, not in a session — so the binding alone spends nothing and a
leaked personal token reaches that user's PAT (as a leaked session would) but not their
subscription.

A bound key attributes EVERY run it starts, not only the ones needing an unlock. The alternative
makes one key produce runs under two identities depending on which model a task happened to pin,
with two credential scopes and two merge-policy roles, and nothing in the request to say which.

Deliberately not lifted: `POST /api/v1/notifications/:id/act`. Its ci-/test-failure arm retries
through a shared effect that mints no activation, so admitting a bound key there would trade a
refusal the caller can act on for a run that dies at its first dispatch. Lifting it means threading
the gate through that effect for the SPA and this surface at once.

**The acceptance suite** now runs on the operator's own subscription. It prompts for the personal
password at the terminal on the first call that needs one — never at `configure` time, and never at
all for a workspace on a provider API key — and holds it in memory only: not the `.env`, not the
ledger, not the journal, because a copy beside `CAT_FACTORY_API_KEY` would put both halves of a
two-factor credential in one file. The header then rides every request, since answering a park
re-mints the run's activation server-side. `configure` and the `model-preset` gate now say "not
visible to this system token" and name the fix, instead of the wrong one they used to name.
