---
'@cat-factory/contracts': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/sdk': patch
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/acceptance': patch
---

`GET /api/v1/models` now says whether a model's subscription is actually CONNECTED for the person a
key belongs to, and stops calling the commonest one unwired. Surface version 1.47.0, additive: two
new response fields and no change to anything already published.

**The bug.** `userScoped` was added so a caller could tell "your credential was never consulted" from
"no provider is wired", and it was derived from the route IN FORCE. A model with more than one route
resolves, when nothing is configured, to the most-preferred route it merely DECLARES, and
`subscription` is last in that order, so `claude-opus`, the built-in Claude preset's own model, which
also declares OpenRouter, answered `userScoped: false`. The flag shipped to remove that misreport
never fired for the model every report of it has been about; the acceptance suite kept printing "no
provider wired for it" at operators whose workspace runs Claude every day, and the fix it named (add
a provider key) was for a deployment that was already correct.

**Why a new field rather than a corrected one.** `userScoped` is published, and correcting it in
place would have moved its meaning in two directions at once: true where a model merely declares a
subscription route (right), and no longer true for a POOLED vendor whose subscription route is in
force (also right, and also a change under any consumer branching on it). So `userScoped` keeps
answering exactly what it always answered and is marked superseded, `personalSubscription` is served
beside it, and dropping the old half is a later change. `personalSubscription` is true where a model
declares a subscription route whose vendor is individual-usage only, read through kernel's own
`individualVendorForModelId`, the same predicate the run path gates a personal credential on. The
pooled exclusion matters: a Kimi or DeepSeek token belongs to the WORKSPACE, so every key can already
see it, and reporting one as personal sent an operator to re-mint a token when the fix was a pooled
token or a provider key.

**The existence field.** `personalSubscription` alone still stops one step short of useful: told a
row cannot be judged, an operator's next move is to re-mint the token bound and see what happens,
which is exactly how the last person to hit this found the answer. Each row now carries
`subscriptionConfigured`: whether a personal subscription for that vendor is stored for the person
the key belongs to (`actsAsUserId` when bound, else its minter), and `null` when there was nobody to
ask about. Existence is a row lookup, so the deployment answers it without the personal password that
OPENS the credential.

That is also the correction to 1.45.0's reasoning, which rejected reporting this on the grounds that
"the server cannot know whether one exists without a user". An unbound key does have a user for
DESCRIPTION purposes: its minter, who is exactly who the remedy names. Reading it changes nothing
about admission: `available` is still resolved under `actsAsUserId` alone, so a system token reads
`available: false` beside `subscriptionConfigured: true`, and both are true. `createdByUserId` rides
`PublicApiKeyAuth` for that one reader and stays provenance; nothing authorizes off it. The
disclosure this trades (an `admin`-scoped key learns one bit about its minter, who need not be its
holder) is documented on the field and in `public-api.md`.

**Three fixes underneath.** A LAPSED personal subscription reported as configured (`has` checked
existence where `unlock` checks expiry), so the catalog offered a model whose run was then refused at
its first dispatch, naming the model rather than the subscription. Both credential stores answered
the vendor sweep one single-row question at a time; `PersonalSubscriptionService.liveVendors` and the
new `ProviderSubscriptionService.liveVendors` each answer the whole vocabulary in one read, on a path
both the catalog render and every run start take. The pooled half needed a new
`ProviderSubscriptionTokenRepository.listByWorkspace`, mirrored across D1, Drizzle and the local
sqlite credential store with a conformance assertion.

The acceptance suite reads all of it: `configure`'s menu and the `model-preset` / `agent-model` gates
now distinguish five states with five different fixes, with the account model-family policy ranked
ahead of every credential state (it is the one cause no credential can undo) and the state that
matters most saying the subscription is connected and naming the token as the only thing in the way.
