# Per-model Bedrock enablement + per-preset provider preference

**Status:** design agreed, not yet implemented. Tracker lands with
[#1602](https://github.com/kibertoad/cat-factory/pull/1602); implementation follows.

## Goal

Two changes to how a catalog model resolves to a route:

1. **Bedrock becomes a selectable flavour, enabled per model** — today Bedrock is reachable
   only as a deployment-wide routing default, so a user cannot pin a task to it.
2. **The order routes are preferred in becomes a per-preset choice**, edited in the model
   preset editor, instead of a constant compiled into `effectiveVariant`.

## Why

`BEDROCK_MODELS` is **already a per-model allow-list** — the operator enumerates exactly the
ids their account can call in their Region. Nothing consumes that list except a
throw-on-mismatch guard in `@cat-factory/provider-bedrock`. The capability set is sitting
there unused.

The sharper argument is that the account model policy already ships
`trustedProviders: ['bedrock']`, whose whole purpose is to let an otherwise-blocked family
through **on a residency-guaranteed route**. With no selectable Bedrock flavour that
exemption is only reachable by repointing the entire deployment's routing default — so the
feature is half-wired today, which is exactly what `CLAUDE.md` says not to leave behind.

Preference has to be per-preset rather than per-deployment because it is a per-workload
choice: the same workspace legitimately wants a compliance preset pinned to Bedrock and an
everyday preset riding a flat-rate subscription. **No new env variables** — the knob is the
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

> **This is a behaviour change, and it is the riskiest part of the work.** Today
> `effectiveVariant` orders `direct > openrouter > cloudflare > subscription` and the
> "subscriptions win" rule is applied _on top_, separately, by the executor and the frontend.
> Unifying them into one order is the right end state but it touches
> `personalCredentialVendorForModelId`, whose dual-mode reasoning keys off whether a model has
> a non-subscription **base**, plus `RunAdmission` and `ContainerAgentExecutor.resolveEffectiveRef`.
> Do this as its own commit with the individual-vendor gating tests green before layering
> anything else on it.

### A preference REORDERS, never filters

Flavours a preset omits are appended in default order and tried last. A preset naming three
flavours must not make a model whose only route is the fourth unresolvable — it should just
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
naturally per model: an id absent from the list is a model this account cannot call.

Note Bedrock **lags the vendors' own APIs** — its newest Anthropic model is Opus 4.8, not the
Opus 5 the subscription flavour runs. Bedrock refs are therefore their own catalog entries or
their own `ModelRef`s, never assumed equal to the direct flavour's model.

### Where the preference travels

On `ProviderCapabilities`, not as a function parameter. Every resolution site already threads
a capability set, so a new call site cannot silently resolve under a different order than the
picker displayed. `ProviderCapabilities` gains `bedrockModels?: Set<string>` and
`providerPreference?: readonly ModelFlavor[]`.

## Work items

- [ ] `contracts`: `modelFlavorSchema`; `ModelPreset.providerPreference` (+ create/update
      bodies, duplicate check); widen `modelOptionSchema.flavor`.
- [ ] `kernel`: `MODEL_FLAVORS` / `DEFAULT_PROVIDER_PREFERENCE`; `SelectableModel.bedrock`;
      `resolveBedrockModelId`; rewrite `effectiveVariant` to be preference-driven.
      **Pin `MODEL_FLAVORS` against the contracts picklist with a type-level assertion** or
      the two lists drift silently.
- [ ] `kernel`: the subscription-first reorder, with `personalCredentialVendorForModelId`,
      `RunAdmission` and `resolveEffectiveRef` re-verified (see the warning above).
- [ ] Catalog: `bedrock` flavours on the entries Bedrock actually serves (Claude Opus 4.8,
      Sonnet, `openai.gpt-5.5`/`gpt-5.4`, `openai.gpt-oss-*`, Llama, Nova).
- [ ] Persistence, **both runtimes**: `provider_preference` on `model_presets` — a D1
      migration ⇄ Drizzle schema + `pnpm db:generate` + mappers + repos. Stored as a JSON
      array; NULL ⇒ default.
- [ ] Capability wiring, **both runtimes**: `BEDROCK_MODELS` → `caps.bedrockModels`;
      the resolved preset's order → `caps.providerPreference`.
      `resolveWorkspaceCapabilities` (`@cat-factory/server`) is the join point.
- [ ] `server`: `ModelRouter` / `ContainerAgentExecutor` resolve the preference from the
      preset in force, once per dispatch (same rule as the prompt override).
- [ ] Frontend: preference editor in `ModelConfigurationPanel.vue` (ordered list, reset to
      default), the flavour badge in the picker, **and `en.json` + all 9 other locales** —
      the parity gate is change-coupled, and a verbatim English value is a bug.
- [ ] Conformance: a `defineConformanceSuite` assertion that a preset's stored preference
      round-trips and changes which flavour a model resolves to on BOTH runtimes.
- [ ] Docs: `backend/docs/model-support.md` §2 (flavour table, precedence), §8 (replace the
      "Bedrock contributes nothing to the picker, by design" paragraph added in #1602 — it
      documents the state this initiative removes).

## Gotchas found while scoping

- **`SelectableModel` had no `bedrock` field and `ModelOption.flavor` is a wire picklist**, so
  adding the flavour is a contracts change, not a kernel-local one. The SPA's flavour badge
  switches on it.
- **`model_presets` is column-per-field, not a JSON blob**, so this needs real mirrored
  migrations rather than a free-form config key.
- **`effectiveVariant` has two loops** (usable-first, then declared-first as a best-effort
  fallback). Both must walk the same order, or an unconfigured deployment shows one route in
  the picker and runs another.
