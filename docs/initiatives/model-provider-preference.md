# Per-model Bedrock enablement + per-preset provider preference

**Status:** slices 1 (Bedrock as a selectable flavour, on a preference-driven resolver) and 2
(the per-preset preference) landed. Slice 3 (the subscription-first reorder) outstanding.
Tracker landed with [#1602](https://github.com/kibertoad/cat-factory/pull/1602).

## Slicing (REDIRECTED after scoping slice 1)

The original plan put the **subscription-first reorder first**, on the reasoning that it is
the riskiest change and everything else layers on it. Implementing against the code showed the
reorder is bigger than "its own commit", and doing it first would have blocked both features
behind it, so the order was inverted. What the reorder actually touches:

- **`ModelRouter.resolveEffectiveRef` treats a truthy `ref.harness` as proof of
  entitlement.** With `subscription` first in the tuple, the deployment-level
  `resolveBlockModel` (built at boot from capabilities asserting EVERY vendor, because no
  workspace is in hand yet) hands back a harness ref for any dual-mode model, and the router
  then sets `subscriptionVendor` without consulting `hasSubscriptionToken` /
  `hasPersonalSubscription`. A workspace holding no token would dispatch a subscription run.
- **~10 inline call sites degrade to the wrong thing.** Each is
  `inlineModelRef(ref, fallback ?? ref, { runsInline })`, and `inlineModelRef` sees only a
  ref, not a model id, so a dual-mode pin would degrade to the ROUTING DEFAULT instead of
  the model's own non-subscription base. A GLM-pinned reviewer would silently run Qwen.

So the reorder needs the per-workspace and inline-eligibility facts to reach resolution
(re-plumbing `resolveBlockModel`, and giving the inline paths a model-aware degrade), which
is a slice of its own rather than a preliminary commit. Slice 1 therefore kept
`DEFAULT_PROVIDER_PREFERENCE` at the HISTORICAL order with `bedrock` inserted where the design
wants it (`direct > bedrock > openrouter > cloudflare > subscription`), so a Bedrock route
changes nothing else about how a model resolves. The reasoning is recorded beside the tuple and
in `model-support.md` §4, so the next iteration doesn't re-propose the withdrawn ordering.

## Goal

Two changes to how a catalog model resolves to a route:

1. **Bedrock becomes a selectable flavour, enabled per model**: today Bedrock is reachable
   only as a deployment-wide routing default, so a user cannot pin a task to it.
2. **The order routes are preferred in becomes a per-preset choice**, edited in the model
   preset editor, instead of a constant compiled into `effectiveVariant`.

## Why

`BEDROCK_MODELS` is **already a per-model allow-list**: the operator enumerates exactly the
ids their account can call in their Region. Nothing consumes that list except a
throw-on-mismatch guard in `@cat-factory/provider-bedrock`. The capability set is sitting
there unused.

The sharper argument is that the account model policy already ships
`trustedProviders: ['bedrock']`, whose whole purpose is to let an otherwise-blocked family
through **on a residency-guaranteed route**. With no selectable Bedrock flavour that
exemption is only reachable by repointing the entire deployment's routing default, so the
feature is half-wired today, which is exactly what `CLAUDE.md` says not to leave behind.

Preference has to be per-preset rather than per-deployment because it is a per-workload
choice: the same workspace legitimately wants a compliance preset pinned to Bedrock and an
everyday preset riding a flat-rate subscription. **No new env variables**: the knob is the
preset row.

## Target design

### The flavour vocabulary

`ModelFlavor = 'subscription' | 'direct' | 'bedrock' | 'openrouter' | 'cloudflare'`, declared
in `@cat-factory/contracts` (`modelFlavorSchema`) and mirrored as a `const` tuple in kernel.
`effectiveVariant` builds `Record<ModelFlavor, …>` maps for both "how to build this variant"
and "is it usable", so **a new route fails to compile until every arm is handled**.

### Default order

`subscription > direct > bedrock > openrouter > cloudflare`

Two rules, both stated by the repo owner: a **subscription wins over anything metered** (it
is flat-rate quota already paid for, so spending tokens beside it is waste), and a
**first-party route wins over an aggregator** (`direct`/`bedrock` before `openrouter`, which
resells them). Cloudflare stays last as the always-available floor.

> **This is a behaviour change and the riskiest part of the work: it is slice 3, NOT the
> first step.** Slice 1 shipped `direct > bedrock > openrouter > cloudflare > subscription`
> (the historical order with `bedrock` inserted), because the "subscriptions win" rule is
> applied _on top_, separately, by `ModelRouter.resolveEffectiveRef` and each inline call
> site's `inlineModelRef` degrade, and each of those knows something the kernel resolver is
> not given. See the redirect note at the top for what moving it actually requires; the
> individual-vendor gating tests must be green through it.

### A preference REORDERS, never filters

Flavours a preset omits are appended in default order and tried last. A preset naming three
flavours must not make a model whose only route is the fourth unresolvable; it should merely
be less preferred. The write boundary refuses duplicates (ambiguous to read back in the
editor) but accepts partial lists.

### Bedrock ids and the Region problem

The catalog declares the **base** id (`anthropic.claude-opus-4-8`). The id an account
actually calls carries a geo/global inference prefix (`us.` / `eu.` / `jp.` / `au.` /
`global.`) that differs per Region, so any prefix baked into the catalog is wrong for every
deployment but one. Resolution matches an allow-list entry that **is** the base or **ends in
`.<base>`** and uses that entry verbatim:

```ts
resolveBedrockModelId('anthropic.claude-opus-4-8', caps) // 'eu.anthropic.claude-opus-4-8'
```

That is what lets ONE catalog be correct in every Region, and it is why enablement is
naturally per model: an id absent from the list is a model this account cannot call. The
prefix set is never enumerated in code (the suffix match covers a prefix AWS adds later), and
where an operator lists two profiles for one model the FIRST wins, so ordering the env var is
how they choose between a regional and a global one.

Bedrock **lags the vendors' own APIs**: its newest Anthropic model is Opus 4.8, not the
Opus 5 the subscription flavour runs. Bedrock refs are therefore their own catalog entries or
their own `ModelRef`s, never assumed equal to the direct flavour's model. Slice 1 applied that
literally: `gpt-5.5` and `gpt-oss-120b` carry a `bedrock` flavour (Bedrock serves the same
generation), while Opus 4.8 is its own `claude-opus-4-8` entry rather than a flavour on
`claude-opus`, which would silently run 4.8 for a block pinned to 5.

**Llama and Nova are still unenabled**, and deliberately: their concrete Bedrock ids
(suffix conventions like `-v1:0` included) could not be verified against a live account, and a
base id that never matches an allow-list entry is a permanently unselectable catalog row. Add
them from `aws bedrock list-foundation-models` / `list-inference-profiles` output rather than
from memory.

### Where the preference travels

On `ProviderCapabilities`, not as a function parameter. Every resolution site already threads
a capability set, so a new call site cannot silently resolve under a different order than the
picker displayed. `bedrockModels?: Set<string>` landed in slice 1;
`providerPreference?: readonly ModelFlavor[]` comes with slice 2, together with the preset row
that sets it (an unwired capability field would read as a knob nobody can turn).

`bedrockModels` is a `Set` whose ITERATION ORDER is load-bearing (it is the operator's declared
order, which decides between two inference profiles for one model), so it is built from the env
string once and never rebuilt from an unordered source.

Slice 2 landed `providerPreference` on that interface and added a second travel path beside it,
because a capability set is resolved at two different times: the START GUARD resolves one per
run (so `resolveProviderCapabilities` gained the block's `modelPresetId`), while a DISPATCH has
no capability set of its own — the facade's `resolveBlockModel` closes over the boot-time one. So
the order reaches a dispatch through `AgentRunContext.providerPreference`, resolved once by the
engine exactly like the prompt override, and the facade folds it onto its closed-over
capabilities per call. Both ends read one preset row; neither can differ from the other.

## Work items

### Slice 1: Bedrock as a selectable flavour (LANDED)

- [x] `contracts`: `modelFlavorSchema`; widen `modelOptionSchema.flavor` to it.
- [x] `kernel`: `MODEL_FLAVORS` / `DEFAULT_PROVIDER_PREFERENCE`; `SelectableModel.bedrock`;
      `resolveBedrockModelId`; `effectiveVariant` rewritten as a preference walk over an
      exhaustive `Record<ModelFlavor, …>`. The tuple is pinned to the contracts picklist by
      `satisfies` one way and by `model-flavors.test.ts` the other: a flavour contracts gained
      but the tuple lacks would never be TRIED, and no typecheck can see that (the resolver
      walks the tuple, not the union).
- [x] Catalog: `bedrock` on `gpt-5.5` + `gpt-oss-120b` (same generation Bedrock serves) and a
      new Bedrock-only `claude-opus-4-8` entry.
- [x] Capability wiring, both runtimes: `BEDROCK_MODELS` → `caps.bedrockModels`, through the
      ONE `bedrockAllowListFromEnv` parser that also constrains the resolver's own allow-list,
      so the picker cannot offer an id the resolver throws on. Derived from `env` at each
      container literal (like `baseUrlFor`) rather than threaded through the model deps; the
      Worker reads it through `bedrockModelsCapability`, which also requires a registered
      registry serving `bedrock` (see the gotcha below).
- [x] Docs: `model-support.md` §2 (flavour table + the two walks), §4 (why the subscription
      layer stays separate), §8 (replaces the "contributes nothing to the picker" paragraph);
      `environment-variables.md`.

Gotchas this slice surfaced, for whoever takes the next two:

- **A Bedrock ref's context window can't be keyed on the ref.** `contextWindowFor` is keyed
  `${provider}:${model}` and a Bedrock ref carries the operator's PREFIXED id, so the window is
  stored per catalog BASE id and looked up through the same suffix match resolution uses. Miss
  this and the LLM proxy silently stops capping requested output for every Bedrock model.
- **A best-effort build must still produce a ref.** A Bedrock-only entry has no other route, so
  returning nothing when the allow-list misses would make `effectiveVariant` THROW on every
  deployment without Bedrock. It falls back to the base id, flagged `available: false`.
- **`BEDROCK_REGION` without `BEDROCK_MODELS`** deliberately contributes no flavour: the
  resolver runs unconstrained but the platform has nothing to enumerate, and Bedrock grants are
  per account and Region, so offering the catalog's Bedrock entries would surface models AWS
  rejects at call time.
- **On the Worker, the env vars alone must not grant the capability.** Node's `BEDROCK_REGION`
  both registers the resolver and enables the flavour, so env implies dispatchability; the
  Worker's provider arrives through `registerModelRegistry`, so `bedrockModelsCapability`
  additionally checks that a registered registry serves `bedrock` and warns when the vars are
  set without one. Review finding on this slice; any future env-enabled flavour whose provider
  is a code mix-in owes the same gate.
- **No prompt-caching claim.** `providerCachePolicy('bedrock')` stays `none`, so the picker
  reports `cachesPrompts: false`. Bedrock does support Anthropic-style cache breakpoints, but
  the hint is model-specific and we do not send it; claiming caching we don't implement would
  be worse than reporting none.
- **Spend pricing can only be a BARE provider entry today.** `priceFor` matches
  `provider:model` exactly and a Bedrock ref carries the operator's Region prefix, so a
  per-model key silently never matches. The bare `bedrock` rate therefore errs high (the
  frontier tier this catalog can select there), because `defaultPrice` would have metered an
  Opus-on-Bedrock run at roughly a thirtieth of its cost and a budget safeguard must not
  undercount. **Follow-up worth taking:** teach `priceFor` the same prefix-tolerant match
  `contextWindowFor` now uses, then price the Bedrock models individually, which also stops a
  cheap model (`openai.gpt-oss-120b`) being metered at the frontier rate.

### Slice 2: per-preset provider preference (LANDED)

- [x] `contracts`: `ModelPreset.providerPreference` (+ create/update bodies, duplicate check),
      plus `DEFAULT_MODEL_FLAVOR_ORDER` / `orderedModelFlavorPreference` / `isModelFlavor`.
- [x] Persistence, **both runtimes**: `provider_preference` on `model_presets`, a D1
      migration ⇄ Drizzle schema + `pnpm db:generate` + mappers + repos. Stored as a JSON
      array; NULL ⇒ default.
- [x] `kernel`: `ProviderCapabilities.providerPreference`, and `effectiveVariant` walking it
      with the omitted flavours appended in default order (a preference REORDERS, never
      filters).
- [x] Capability wiring, **both runtimes**: the resolved preset's order →
      `caps.providerPreference`. `resolveWorkspaceCapabilities` is the join point.
- [x] `server`: `ModelRouter` / `ContainerAgentExecutor` resolve the preference from the
      preset in force, once per dispatch (same rule as the prompt override).
- [x] Frontend: `ProviderPreferenceEditor.vue` in the preset editor (ordered list, reset to
      default), **and `en.json` + all 9 other locales**.
- [x] Conformance: a `defineConformanceSuite` assertion that a preset's stored preference
      round-trips and changes which flavour a model resolves to on BOTH runtimes.

Gotchas this slice surfaced, for whoever takes slice 3:

- **`resolveBlockModel` is where the order has to arrive, and it is a CLOSURE over boot-time
  capabilities.** Widening it to `(modelId, providerPreference?)` is additive, so no existing
  call site broke, but note the shape it forces: the facade folds the order onto its captured
  caps per call rather than the caller passing a whole capability set. That is deliberate —
  which routes EXIST is a deployment fact and only the ORDER is per preset — and slice 3's
  per-workspace token state cannot use the same trick, because it changes what is usable.
- **The dispatch and the start guard needed DIFFERENT travel paths** (see "Where the preference
  travels" above). Adding only the guard's would have left every dispatch on the default order,
  and adding only the context's would have let a run be admitted against a route it never takes.
- **Eight inline callers each hand-rolled the step precedence.** The judge, the fork chat, the
  iterative reviewers (+ the brainstorm/clarity subclasses), the doc/initiative interviewers, the
  tester QC companion, the bug-hunt assessor and the Kaizen grader carried byte-identical private
  `modelFor` methods, so the order had to reach eight places. They now share
  `resolveInlineBlockModelRef` (`orchestration/src/inlineBlockModel.ts`, the model twin of
  `inlineScope.ts`) and one wiring factory (`container/inline-model-deps.ts`). **The model and the
  route order arrive as ONE `resolvePresetRouting` dependency**, not two wired side by side, and
  the eighth caller is why: Kaizen resolved through a seam with no `providerPreference` parameter,
  so it took the factory's model half and silently ignored the order — a compliance preset got its
  route for every inline call on a block except its grading. Two columns of one row, wired apart,
  is an invitation to take one; wired together it is also ONE read instead of two.
- **That row is read on EVERY dispatch and every inline call**, so it goes through an
  `AppCaches.modelPreset` slice — the merge preset's `riskPolicy` twin one table over, same key
  shape (`picked:<id>` / `default`), same invalidate-on-every-write rule in `ModelPresetService`,
  same pass-through on the Worker's isolate-safe profile. Slice 3 adds per-workspace token state
  to this resolution; that state is NOT cacheable on this key (it varies by run initiator), so it
  has to ride the capability set rather than the preset row.
- **"Equals the default order" must be stored as ABSENT.** The editor emits `undefined` when a
  reordering lands back on the default, and an empty list on the wire is the reset. Otherwise a
  preset would pin a copy of today's order and silently stop following it — which is exactly what
  slice 3 changes, so this is the one normalisation slice 3 depends on.
- **The default order lives in contracts, not kernel**, because the editor renders the same fold
  the resolver walks. Slice 3's reorder is therefore ONE edit: the `modelFlavorSchema` picklist
  order IS `DEFAULT_MODEL_FLAVOR_ORDER` (pinned both ways by `model-flavors.test.ts`).
- **A retired route is DROPPED at the persistence boundary**, not named — the opposite
  disposition from `isBinaryModality`, and deliberately: the value names a ROUTE, so once the
  route is gone there is no current member a human could re-pick it as, and the surviving entries
  keep their relative order. What it must never do is reach a `Record<ModelFlavor, …>` lookup,
  which is why `parseProviderPreferenceColumn` narrows with `isModelFlavor` first.
- **The subscription override sits ON TOP of this order, and the editor has to SAY so.**
  `ModelRouter.resolveEffectiveRef` swaps the resolved ref for the subscription one whenever the
  workspace (or, for an individual vendor, the initiator) holds a token, so on such a deployment a
  preset promoting Bedrock is overruled for every dual-mode model. Until slice 3 folds that
  override into this order, `ProviderPreferenceEditor` warns whenever a custom order does not
  itself put `subscription` first (`subscriptionOverridesOrder`). **Slice 3 deletes that warning**;
  it is the visible marker of exactly what slice 3 is for.
- **`GET /models` resolves its flavour badges under the WORKSPACE DEFAULT preset**, because a
  workspace-wide read has no block in hand. That is right for the API and wrong-looking in the
  editor, where the badges sit beside an order for some other preset — so the editor says which
  preset the badges are about whenever the two can differ.
- **Not verified against live databases in the authoring session** (no Docker/Postgres, and the
  Worker tests don't run on Windows). The migration pair, the mappers and the conformance
  assertion are typechecked and the pure-logic suites are green; CI's real-D1 + real-Postgres
  conformance run is the actual proof.

### Slice 3: the subscription-first reorder

Scope per the redirect above, and it is the riskiest of the three.

- [ ] Give resolution the facts the rule needs: per-workspace/initiator token state must reach
      `resolveBlockModel` (today deployment-level and vendor-permissive), and the inline paths
      need a model-aware degrade so a dual-mode pin falls back to its OWN base rather than the
      routing default.
- [ ] Move `subscription` to the front of `DEFAULT_PROVIDER_PREFERENCE`; re-verify
      `personalCredentialVendorForModelId` (its `hasBase` test is now derived from the flavour
      handlers, so it already counts `bedrock`), `RunAdmission.modelIdIsMetered` and
      `ModelRouter.resolveEffectiveRef`, with the individual-vendor gating tests green.
- [ ] Retire the now-redundant "subscriptions win" layers: `ModelRouter`'s override and the
      SPA's `displayFlavor` subscription branch. Prefer deleting to leaving both.

## Gotchas found while scoping

- **`SelectableModel` had no `bedrock` field and `ModelOption.flavor` is a wire picklist**, so
  adding the flavour is a contracts change, not a kernel-local one. The SPA's flavour badge
  switches on it.
- **`model_presets` is column-per-field, not a JSON blob**, so this needs real mirrored
  migrations rather than a free-form config key.
- **`effectiveVariant` has two loops** (usable-first, then declared-first as a best-effort
  fallback). Both must walk the same order, or an unconfigured deployment shows one route in
  the picker and runs another.
