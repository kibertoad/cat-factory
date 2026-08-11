---
'@cat-factory/contracts': patch
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/sdk': patch
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/acceptance': patch
---

`GET /api/v1/models` now says whether a model's subscription is actually CONNECTED for the person a
key belongs to, and stops calling the commonest one unwired. Surface version 1.46.0, additive.

**The bug.** `userScoped` was added so a caller could tell "your credential was never consulted" from
"no provider is wired", and it was derived from the route IN FORCE. A model with more than one route
resolves, when nothing is configured, to the most-preferred route it merely DECLARES, and
`subscription` is last in that order — so `claude-opus`, the built-in Claude preset's own model, which
also declares OpenRouter, answered `userScoped: false`. The flag shipped to remove that misreport
never fired for the model every report of it has been about; the acceptance suite kept printing "no
provider wired for it" at operators whose workspace runs Claude every day, and the fix (add a provider
key) was for a deployment that was already correct. It is now read off what a model DECLARES.

**The field.** `userScoped` alone still stops one step short of useful: told a row cannot be judged,
an operator's next move is to re-mint the token bound and see what happens, which is exactly how the
last person to hit this found the answer. Each row now carries `subscriptionConfigured` — whether a
personal subscription for that vendor is stored for the person the key belongs to (`actsAsUserId` when
bound, else its minter), and `null` when there was nobody to ask about. Existence is a row lookup, so
the deployment answers it without the personal password that OPENS the credential.

That is also the correction to 1.45.0's reasoning, which rejected reporting this on the grounds that
"the server cannot know whether one exists without a user". An unbound key does have a user for
DESCRIPTION purposes: its minter, who is exactly who the remedy names. Reading it changes nothing
about admission — `available` is still resolved under `actsAsUserId` alone, so a system token reads
`available: false` beside `subscriptionConfigured: true`, and both are true: the model is wired, and
this credential may not spend it. `createdByUserId` rides `PublicApiKeyAuth` for that one reader and
stays provenance; nothing authorizes off it.

**Two fixes underneath.** A LAPSED personal subscription reported as configured (`has` checked
existence where `unlock` checks expiry), so the catalog offered a model whose run was then refused at
its first dispatch, naming the model rather than the subscription. And the vendor sweep asked the
personal store one single-row question per vendor; `liveVendors` answers the whole vocabulary in one
read, on a path both the catalog render and every run start take.

The acceptance suite reads all of it: `configure`'s menu and the `model-preset` / `agent-model` gates
now distinguish four states with four different fixes, and the one that matters most says the
subscription is connected and names the token as the only thing in the way.
