# @cat-factory/sandbox

## 0.7.22

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/sandbox-fixtures@0.7.12

## 0.7.21

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/sandbox-fixtures@0.7.12

## 0.7.20

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/sandbox-fixtures@0.7.12

## 0.7.19

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8
  - @cat-factory/sandbox-fixtures@0.7.11

## 0.7.18

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/sandbox-fixtures@0.7.11

## 0.7.17

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/kernel@0.13.4
  - @cat-factory/sandbox-fixtures@0.7.10

## 0.7.16

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/kernel@0.13.3
  - @cat-factory/sandbox-fixtures@0.7.10

## 0.7.15

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/sandbox-fixtures@0.7.9

## 0.7.14

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1
  - @cat-factory/sandbox-fixtures@0.7.8
  - @cat-factory/agents@0.11.3

## 0.7.13

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/agents@0.11.2
  - @cat-factory/sandbox-fixtures@0.7.8

## 0.7.12

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1
  - @cat-factory/sandbox-fixtures@0.7.7

## 0.7.11

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/sandbox-fixtures@0.7.7

## 0.7.10

### Patch Changes

- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/kernel@0.11.1
  - @cat-factory/sandbox-fixtures@0.7.6

## 0.7.9

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/sandbox-fixtures@0.7.6

## 0.7.8

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/kernel@0.10.1
  - @cat-factory/sandbox-fixtures@0.7.5

## 0.7.7

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/sandbox-fixtures@0.7.4

## 0.7.6

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/sandbox-fixtures@0.7.3

## 0.7.5

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/sandbox-fixtures@0.7.3

## 0.7.4

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/sandbox-fixtures@0.7.2

## 0.7.3

### Patch Changes

- fef2964: Add `@cat-factory/sandbox` and `@cat-factory/local-server` to the root `tsc -b`
  build graph (`backend/tsconfig.build.json`). They were publishable (`private: false`,
  `publishConfig.access: public`) and declared `files: ["dist"]`, but neither was
  referenced by the build graph nor pulled in transitively, so `pnpm build` (which
  `ci:publish` runs before `changeset publish`) never produced their `dist`. The last
  release therefore published both with only `package.json` + `LICENSE` and no code.
  This patch re-releases them with their built output. (`@cat-factory/consensus` was
  unaffected — it builds transitively via the cloudflare/node graphs.)

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/sandbox-fixtures@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/sandbox-fixtures@0.7.1

## 0.7.0

### Minor Changes

- 21ca647: Foundation for the **Sandbox** — a parallel, opt-in surface for the organized
  testing of prompts and models. It answers "which model is best for this task?"
  (one prompt, many models) and "does a better prompt help?" (one model, many
  prompt versions).

  This change lands the isolated foundation only (no runtime wiring yet):

  - **`@cat-factory/sandbox`** (new, isolated package): the pure domain logic —
    the testable-agent-kind catalog with live baseline enumeration (read from
    `@cat-factory/agents`, never persisted), append-only prompt-version lineage
    (clone → versioned candidates + freeform labels), experiment-matrix expansion
    into run cells, and the judge rubrics (lifted from the benchmark harness) plus
    a deterministic objective-findings recall scorer. Nothing in the core product
    depends on this package, so the whole feature can be extracted later.
  - **`@cat-factory/contracts`**: Valibot wire contracts for sandbox prompt
    versions, fixtures, experiments, runs, and grades (`sandbox.ts`).
  - **`@cat-factory/kernel`**: the sandbox repository ports
    (`SandboxPromptVersionRepository`, `SandboxFixtureRepository`,
    `SandboxExperimentRepository`, `SandboxRunRepository`,
    `SandboxGradeRepository`) and the re-exported domain types.

  Follow-ups (per the approved design): the server controller, the durable
  fan-out run driver + judge/objective grading, D1 ⇄ Drizzle persistence with a
  conformance assertion, the dedicated fixture repo + ephemeral-branch lifecycle,
  and the lazy-loaded frontend section.

- c4ef995: Add **`@cat-factory/sandbox-fixtures`** — a published package of hand-authored,
  standardized, **graded** no-repo fixtures for the Sandbox, plus the asymmetric
  grading model that scores them.

  - **`@cat-factory/sandbox-fixtures`** (new): inline (text-only) agent inputs that
    need NO repository checkout — `requirements-review`, `clarity-review`, `reviewer`
    (code review), and architecture-proposal review (`architect-companion`) — each
    spanning a simple → complex range. Every fixture declares the genuine findings a
    strong answer should surface, each rated by **trickiness** (how hard to spot —
    catching it is a "wow") and **impact** (how bad to miss). The standardized
    `SandboxFixtureDefinition` projects to the wire `SandboxFixture` via
    `toSandboxFixture`. Depends only on `@cat-factory/contracts` so the published
    `@cat-factory/sandbox` can load it via `workspace:*`.
  - **`@cat-factory/contracts`** (breaking, pre-1.0): the `findings` fixture objective
    now carries graded `expectations` (`{ id, summary, trickiness, impact, matchHints }`)
    instead of a flat `expectedFindings: string[]`; the objective result records the
    asymmetric breakdown (`impactRecall`, `wowBonus`, `caught`/`total`,
    `missedHighImpact`). New `clarity` inline fixture kind.
  - **`@cat-factory/sandbox`**: loads the workspace builtin fixtures by default
    (`listBuiltinFixtures`, re-exporting `@cat-factory/sandbox-fixtures`); replaces the
    flat `scoreExpectedFindings` recall with `scoreExpectations` (impact-weighted miss
    penalty so missing something impactful hurts most, plus a trickiness-weighted "wow"
    bonus for catching the subtle items) and `renderExpectationBrief` for the judge;
    adds the `architecture-review` (`architect-companion`) catalog entry and a
    `suggestExperiment` helper that maps selected models × prompts × fixtures to a
    ready-to-create experiment for a selected agent.

  No CI cache list change is needed: the new package sits under
  `backend/packages/*`, already covered by the workflow's `node_modules` cache glob;
  it is added to the `backend/tsconfig.build.json` composite build graph (the
  incremental `.tsbuildinfo` cache) so it builds before its `@cat-factory/sandbox`
  consumer.

### Patch Changes

- Updated dependencies [fe53445]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [268c15d]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [7d5e060]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
  - @cat-factory/sandbox-fixtures@0.7.0
