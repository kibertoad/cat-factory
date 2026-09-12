# @cat-factory/example-custom-agent

## 0.4.174

### Patch Changes

- 9f8cabc: Re-point the DeepSeek Flash route at the model DeepSeek actually serves, take the agent CLIs at
  their newest, and refresh the dependency tree.
  
  **A retired model behind a live alias.** DeepSeek retired V4-Flash and V4-Flash-Vision-Exp on
  2026-09-10 and made `deepseek-flash` the canonical, unversioned name for V4.1-Flash. The old
  `deepseek-v4-flash` id still resolves, but only as a TEMPORARY compatibility alias onto the new
  model, which is the quietest shape this catalog's failures take: nothing throws and nothing fails
  to dispatch, so the picker went on saying "DeepSeek V4 Flash" while a different model answered, at
  a rate the spend table did not carry, and the route dies outright whenever the alias is withdrawn.
  All three DeepSeek-served arms of the `deepseek` entry (direct, subscription, and the OpenRouter
  one, which must name the same model or the entry straddles two) now name the live model. The entry
  keeps its `deepseek` id: that id is what a workspace persists against a block, and this is the same
  slot following the vendor's own successor, so re-minting it would invalidate every stored pick to
  say nothing new. `acceptsImages` is new on both refs and is a real capability gain rather than a
  correction, since V4.1-Flash folds the vision line back into the main model.
  
  Two adjacent claims were re-read rather than trusted. The 2026-09-10 release note said
  `deepseek-v4-pro` would route to V4.1-Flash from 2026-09-14, which would have silently demoted that
  entry to a cheaper, weaker model; DeepSeek has since decided to keep serving V4 Pro with billing
  unchanged, so it is untouched. And OpenRouter still serves a separate `deepseek/deepseek-v4-flash`
  at a fifth of the price, which this entry deliberately does not keep: it is the retired build, and
  an entry whose direct and gateway arms named different models is the neighbouring-version trap the
  catalog header bans. Both retired price keys stay in the table so historical spend rows keep
  costing correctly.
  
  **No other catalog gap.** Every frontier launch since the last sweep was checked against its
  serving provider and is already here: Claude Fable 5.1, Gemini 3.8 Flash, Muse Spark 1.3 and GPT-6
  Astra. Claude Mythos 5.1 stays out on purpose. It is the same model as Fable 5.1 at identical
  pricing, offered by invitation only through Project Glasswing with no public route on any provider
  this platform reaches, so an entry could only be a re-badge that `effectiveVariant` would pick and
  then fail to dispatch. "Astra Pro" stays out for the reason recorded last time, re-checked here:
  OpenRouter mints a slug for it, but reasoning effort is a parameter on the single `gpt-6-astra` id.
  
  **Agent CLIs at their newest**, ahead of the 24h `minimumReleaseAge` window, as the Dockerfile's
  standing note allows for those three pins alone: Claude Code 2.1.265 to 2.1.270 and Codex 0.153.4
  to 0.154.0 (still above the 0.153.0 floor `gpt-6-astra` needs). Pi holds at 0.85.1, already newest.
  The two Pi extensions do NOT take that exemption and hold at 2.9.0: 2.10.0 published three hours
  before this change and has not aged past the window. Both harness images move to the newest
  `node:26-trixie-slim` digest that has (node 26.8.2), and the executor image tag rolls to 1.158.0
  with the deploy image at 0.6.8.
  
  **Dependency refresh**: direct ranges plus a lockfile re-resolution, 31 resolved names moved, no
  package name dropped. `pg-boss` 12.31.0 brings `rrule-temporal` and `temporal-spec` in as new
  transitive deps, the only additions. A `pnpm dedupe` follows the bump because the partial
  re-resolution left `@types/node` resolved at two patch versions. Four holds are unchanged and were
  re-verified at HEAD rather than assumed: `vitest` at 4.1.11 and `wrangler` at 4.124.0
  (`@cloudflare/vitest-pool-workers` 0.22.0 is still newest, peers `vitest: ^4.1.0` and pins that
  wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the resolved workerd's date, which
  that pool pins), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 reaches for
  `typescript/lib/tsc`, absent from TS 7's exports map). pnpm moves 11.24.0 to 11.26.0, staying on
  its major. WireMock holds at 3.13.1, still its newest non-prerelease. Actions: `setup-java` v6.0.0
  to v6.0.1 and `zizmor-action` v0.6.3 to v0.6.4; every other pinned action is already newest.
- Updated dependencies [9f8cabc]
  - @cat-factory/agents@0.166.2
  - @cat-factory/kernel@0.348.0
  - @cat-factory/prompt-fragments@1.1.48

## 0.4.173

### Patch Changes

- Updated dependencies [69fc66c]
  - @cat-factory/kernel@0.347.0
  - @cat-factory/agents@0.166.1
  - @cat-factory/prompt-fragments@1.1.47

## 0.4.172

### Patch Changes

- Updated dependencies [2cf867d]
  - @cat-factory/agents@0.166.0
  - @cat-factory/kernel@0.346.2
  - @cat-factory/prompt-fragments@1.1.46

## 0.4.171

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/agents@0.165.0
  - @cat-factory/kernel@0.346.1
  - @cat-factory/prompt-fragments@1.1.45

## 0.4.170

### Patch Changes

- Updated dependencies [44b27a7]
  - @cat-factory/kernel@0.346.0
  - @cat-factory/agents@0.164.0
  - @cat-factory/prompt-fragments@1.1.44

## 0.4.169

### Patch Changes

- Updated dependencies [b75fa3c]
  - @cat-factory/kernel@0.345.0
  - @cat-factory/agents@0.163.0
  - @cat-factory/prompt-fragments@1.1.43

## 0.4.168

### Patch Changes

- Updated dependencies [bba4beb]
  - @cat-factory/kernel@0.344.0
  - @cat-factory/agents@0.162.0
  - @cat-factory/prompt-fragments@1.1.42

## 0.4.167

### Patch Changes

- @cat-factory/agents@0.161.1
  - @cat-factory/kernel@0.343.1
  - @cat-factory/prompt-fragments@1.1.41

## 0.4.166

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/kernel@0.343.0
  - @cat-factory/agents@0.161.0
  - @cat-factory/prompt-fragments@1.1.40

## 0.4.165

### Patch Changes

- Updated dependencies [6ff632f]
  - @cat-factory/agents@0.160.0
  - @cat-factory/kernel@0.342.1
  - @cat-factory/prompt-fragments@1.1.39

## 0.4.164

### Patch Changes

- Updated dependencies [ca5be97]
  - @cat-factory/kernel@0.342.0
  - @cat-factory/agents@0.159.1
  - @cat-factory/prompt-fragments@1.1.38

## 0.4.163

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/kernel@0.341.0
  - @cat-factory/agents@0.159.0
  - @cat-factory/prompt-fragments@1.1.37

## 0.4.162

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/kernel@0.340.0
  - @cat-factory/agents@0.158.0
  - @cat-factory/prompt-fragments@1.1.36

## 0.4.161

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/agents@0.157.2
  - @cat-factory/kernel@0.339.0
  - @cat-factory/prompt-fragments@1.1.35

## 0.4.160

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/agents@0.157.1
  - @cat-factory/kernel@0.338.0
  - @cat-factory/prompt-fragments@1.1.34

## 0.4.159

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/kernel@0.337.0
  - @cat-factory/agents@0.157.0
  - @cat-factory/prompt-fragments@1.1.33

## 0.4.158

### Patch Changes

- Updated dependencies [5c50d30]
  - @cat-factory/agents@0.156.3
  - @cat-factory/kernel@0.336.1
  - @cat-factory/prompt-fragments@1.1.32

## 0.4.157

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/agents@0.156.2
  - @cat-factory/kernel@0.336.0
  - @cat-factory/prompt-fragments@1.1.31

## 0.4.156

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/agents@0.156.1
  - @cat-factory/prompt-fragments@1.1.30

## 0.4.155

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/kernel@0.335.0
  - @cat-factory/agents@0.156.0
  - @cat-factory/prompt-fragments@1.1.29

## 0.4.154

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/kernel@0.334.0
  - @cat-factory/agents@0.155.0
  - @cat-factory/prompt-fragments@1.1.28

## 0.4.153

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/kernel@0.333.0
  - @cat-factory/agents@0.154.0
  - @cat-factory/prompt-fragments@1.1.27

## 0.4.152

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/kernel@0.332.0
  - @cat-factory/agents@0.153.1
  - @cat-factory/prompt-fragments@1.1.26

## 0.4.151

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/kernel@0.331.0
  - @cat-factory/agents@0.153.0
  - @cat-factory/prompt-fragments@1.1.25

## 0.4.150

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/kernel@0.330.0
  - @cat-factory/agents@0.152.0
  - @cat-factory/prompt-fragments@1.1.24

## 0.4.149

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/kernel@0.329.0
  - @cat-factory/agents@0.151.0
  - @cat-factory/prompt-fragments@1.1.23

## 0.4.148

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/kernel@0.328.0
  - @cat-factory/agents@0.150.0
  - @cat-factory/prompt-fragments@1.1.22

## 0.4.147

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/kernel@0.327.0
  - @cat-factory/agents@0.149.1
  - @cat-factory/prompt-fragments@1.1.21

## 0.4.146

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/kernel@0.326.0
  - @cat-factory/agents@0.149.0
  - @cat-factory/prompt-fragments@1.1.20

## 0.4.145

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/kernel@0.325.0
  - @cat-factory/agents@0.148.0
  - @cat-factory/prompt-fragments@1.1.19

## 0.4.144

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/kernel@0.324.0
  - @cat-factory/agents@0.147.0
  - @cat-factory/prompt-fragments@1.1.18

## 0.4.143

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/agents@0.146.6
  - @cat-factory/kernel@0.323.2
  - @cat-factory/prompt-fragments@1.1.17

## 0.4.142

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/agents@0.146.5
  - @cat-factory/kernel@0.323.1
  - @cat-factory/prompt-fragments@1.1.16

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
