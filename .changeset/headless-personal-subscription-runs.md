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

`GET /api/v1/models` could not say why a personal subscription's model was unavailable. The existing
`excludesUserScopedModels` flag reports what an answer OMITS, and a subscription model is not omitted
— it is listed, unjudged, because no user's credential store was consulted. Each row now carries
`userScoped`, so the distinction is stated where it applies. Widening the response flag instead was
tried and rejected: with no user resolved the server cannot know whether a personal subscription
exists, so the honest predicate is "this deployment has `ENCRYPTION_KEY`", which is true nearly
everywhere. A flag that is always true stops answering its question, and it would have re-pointed a
published field at a new predicate under the same name.

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

**And a bound run is that person's run all the way through, policy included.** The two public start
routes resolve the bound user's workspace ROLE and pin it, so a headless start is admitted under the
same role-scoped merge narrowing and the same dry-run sandbox its holder gets in the app: a key
cannot land what the person behind it could not. An initiator with no role is not a lenient run, it
is a run with no policy — which is what the bug-hunt adopt route once shipped, and why
`runAdmission.coverage.spec.ts` makes every start route CLASSIFY itself. A retry deliberately keeps
the ORIGINAL run's pinned authority instead (`buildResumedInstance`), because a re-drive is the same
work under the authority it was first granted, and dropping it would launder a dry run into a live
one via restart-from-step-0.

`POST /api/v1/jobs` runs the same personal-credential gate as the board start. Being inline-only
settles what a public run may DO (no container, no push) and says nothing about whose credential it
needs: the inline harness leases a personal subscription for every individual-usage vendor, so
skipping the gate there traded an actionable refusal for a run that dies at its first dispatch.

Deliberately not lifted: `POST /api/v1/notifications/:id/act`. Its ci-/test-failure arm retries
through a shared effect that mints no activation, so admitting a bound key there would trade a
refusal the caller can act on for a run that dies at its first dispatch. Lifting it means threading
the gate through that effect for the SPA and this surface at once.

**Answering a park no longer re-derives a credential that is already fresh.** Each re-mint runs
210k PBKDF2 iterations per vendor, which a human clicking through a run pays once and a headless
driver answering eight follow-ups would pay eight times in a row — seconds of blocked event loop on
Node, a CPU-limit kill on workerd. The interaction path now skips the whole gate while the run holds
an activation with over half its life left, and both facades share one helper, so the SPA gets the
same. The decision surface's refusal is returned as DATA (a `428` in that surface's own envelope,
carrying the vendor and reason) rather than thrown, which is the invariant every other gate there
already keeps.

**`X-Personal-Password` is declared on the operations that read it**, so it reaches
`docs/openapi.json` and the four generated clients instead of being discoverable only by getting a 428. Each client also gained a post-construction setter for it, since that is when a caller learns
it is needed.

**The acceptance suite** now runs on the operator's own subscription. It prompts for the personal
password at the terminal on the first call that needs one — never at `configure` time, and never at
all for a workspace on a provider API key — and holds it in memory only: not the `.env`, not the
ledger, not the journal, because a copy beside `CAT_FACTORY_API_KEY` would put both halves of a
two-factor credential in one file. The header then rides every request, since answering a park
re-mints the run's activation server-side. `configure` and the `model-preset` gate now say "not
visible to this system token" and name the fix, instead of the wrong one they used to name — read
off the ROW, so a model that genuinely has no provider still reads as unwired, and an invisible
workspace default stays SELECTED rather than being quietly swapped for a model nobody chose.

The prompt opens the CONTROLLING TERMINAL rather than reading `process.stdin`. The suite runs under
vitest, whose workers are forked with piped stdio, so a prompt built on stdin could never have asked
anything: the one path this exists for would have thrown "stdin is not a terminal" on every pass. It
is also stricter than the check it replaces, since a controlling terminal cannot be fed from a pipe
or a file at all. And the entered password is no longer trimmed: a space is printable ASCII, so a
legal password with one at either end was being silently altered and then reported as wrong.
