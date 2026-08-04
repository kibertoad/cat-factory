# @cat-factory/example-custom-agent

## 0.4.5

### Patch Changes

- @cat-factory/agents@0.110.4
- @cat-factory/kernel@0.234.2
- @cat-factory/prompt-fragments@0.15.60

## 0.4.4

### Patch Changes

- @cat-factory/agents@0.110.3
- @cat-factory/kernel@0.234.1
- @cat-factory/prompt-fragments@0.15.59

## 0.4.3

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/kernel@0.234.0
  - @cat-factory/agents@0.110.2
  - @cat-factory/prompt-fragments@0.15.58

## 0.4.2

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/agents@0.110.1
  - @cat-factory/prompt-fragments@0.15.57

## 0.4.1

### Patch Changes

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/kernel@0.232.0
  - @cat-factory/agents@0.110.0
  - @cat-factory/prompt-fragments@0.15.56

## 0.4.0

### Minor Changes

- e7e4404: Reusable operations, slice 2: one descriptor-driven form vocabulary behind both surfaces that have
  one, and a custom task type's collected values are now checked against what it declares.

  An initiative preset and a custom task type had grown the same feature twice, and the task type was
  the poorer copy: four input types against eight, no defaults, no conditional visibility, no shared
  validation, and two near-identical Vue renderers. So a form an org could express as a preset was
  unexpressible as an operation, and nothing but the create form enforced a `required` marker or an
  option list. `contracts/src/form-fields.ts` is now the union both draw on (the field shape, the
  filled-value bag, and the pure visibility / validation / sanitization / prose-rendering rules), with
  each surface declaring only which input types it admits. `password` is excluded for a task type by
  construction rather than by convention: a collected value is folded into prompts, projected onto the
  board snapshot and captured in telemetry, so a secret belongs in the capability-credential store.

  `taskTypeFields.custom` widens from `string | number` to the shared bag (adding booleans and
  multi-select `string[]`), and the prompt fold renders the new shapes through the same renderer the
  form review uses, so a multi-select reads as its option captions rather than its stored enum values.
  Rows are read back through an unvalidated JSON parse, so nothing existing breaks and there is nothing
  to migrate. Two INTERNAL breaks ride along, in the bounds the shared bag carries that the old
  untyped record did not: a bag KEY is now capped at 80 characters and a string VALUE at 2000, so a
  value longer than that (only reachable through a bespoke `formPanel`, since a declared `maxLength`
  cannot exceed the same bound) is refused on the way in.

  `BoardService.addTask` now validates a registered type's bag against its descriptor and freezes only
  the declared, currently-visible answers, so one rule covers the SPA, the internal API and (from the
  public-API slice) a headless caller. An ABSENT bag is checked against an empty one, because a
  required field is unanswered whether the caller sent `custom: {}` or no `custom` key at all: a check
  the caller can opt out of by sending nothing is not a check. **Behaviour change for a deployment
  that registers an operation with required fields**: any path creating such a task without its
  parameters (an initiative item's `spawn`, a script) now gets a 422 where it previously created a
  task whose operation brief was empty. Three cases still deliberately pass through unchecked: a
  built-in type (schema-typed fields, already validated), a type this process does not register (a
  supported row, since task types are node-local by design and degrading data must not brick
  creation), and a descriptor declaring a bespoke `formPanel`, which owns its own bag.

  The richer vocabulary brings new ways for a descriptor to break itself, so boot validation now
  refuses a create form that structurally cannot be filled: a duplicate field key, an optionless
  `select`/`checkbox-group`, or a `showWhen` gating a field on a key the type does not declare (which
  would hide that field forever). Each is fully known from the registration and silent at run time,
  unlike a `defaultFragmentIds` id, which stays a warning because a tenant-tier fragment is invisible
  at boot. Both surfaces are held to that bar by one checker, so an initiative preset's create form is
  validated at boot for the first time (all three facades pass the registry).

  Behaviour change worth reviewing: a custom task type's `select` field renders as a dropdown rather
  than a button row, since it is now the shared renderer, and a form with many options needed that
  anyway. The path-invalid message moved from `initiative.create.pathInvalid` to `common.pathInvalid`,
  carrying each locale's existing translation.

  One unfilled value is now dropped rather than frozen, on both surfaces. Validation short-circuits on
  a value that says nothing, so a `false` on a text field, a blank string or an empty multi-select
  reached the freeze having passed no type check; sanitization now drops them, which stops a
  wrong-typed answer reaching agents as the operation's own brief (`notes: false` rendered as
  `Notes: No`). The one exception is an explicit `false` on a `checkbox`, which is the opt-OUT of a
  default-ON toggle and the one unfilled value that is an answer.

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/kernel@0.231.0
  - @cat-factory/agents@0.109.2
  - @cat-factory/prompt-fragments@0.15.55

## 0.3.1

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/kernel@0.230.0
  - @cat-factory/agents@0.109.1
  - @cat-factory/prompt-fragments@0.15.54

## 0.3.0

### Minor Changes

- fccb1df: Reusable operations, slice 1: a registered custom task type can now carry its whole bundle, and the
  per-case values a user fills reach the agents that act on them.

  A custom task type's collected `taskTypeFields.custom` bag previously reached ZERO prompts: it rode
  the run context and nothing rendered it, so an operation's brief ("expose CRUD for Order", "auth:
  service-to-service") was invisible to every step in the pipeline. The engine now resolves a labelled
  projection once per dispatch (`AgentRunContext.customTaskType`, joined from the registered
  descriptor by kernel's `describeCustomTaskType`) and the agents package renders it as a
  `## Task parameters` section at all three prompt-assembly points, including the prepend a registered
  kind that authors its own user prompt gets.

  The descriptor gains two optional fields: `defaultFragmentIds`, the operation's standing context,
  unioned onto every new task's own fragment selection at creation, and `presentation.category`, the
  picker grouping axis a later slice renders. Boot validation warns (never refuses) on a
  `defaultFragmentIds` entry the code pool cannot resolve, because an account/workspace-tier fragment
  merges per workspace at run time and is invisible at boot.

  Every existing prompt is byte-identical: the projection is absent whenever a block collected no
  custom values, which is every run of a built-in task type. It is also absent for an un-namespaced
  type, so a built-in carrying a stray `custom` bag renders no section: a custom type is namespaced by
  construction, so the raw-id fallback that honestly names a withdrawn operation would otherwise invent
  one. Seeding the standing context STATES a namespaced type this process does not register, since only
  the id set freezes at creation and that task never gains the operation's fragments later.

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/kernel@0.229.0
  - @cat-factory/agents@0.109.0
  - @cat-factory/prompt-fragments@0.15.53

## 0.2.30

### Patch Changes

- @cat-factory/agents@0.108.3
- @cat-factory/kernel@0.228.1

## 0.2.29

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/agents@0.108.2

## 0.2.28

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/kernel@0.227.0
  - @cat-factory/agents@0.108.1

## 0.2.27

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/kernel@0.226.0
  - @cat-factory/agents@0.108.0

## 0.2.26

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/kernel@0.225.0
  - @cat-factory/agents@0.107.1

## 0.2.25

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/kernel@0.224.0
  - @cat-factory/agents@0.107.0

## 0.2.24

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/kernel@0.223.0
  - @cat-factory/agents@0.106.8

## 0.2.23

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/kernel@0.222.0
  - @cat-factory/agents@0.106.7

## 0.2.22

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/agents@0.106.6
  - @cat-factory/kernel@0.221.1

## 0.2.21

### Patch Changes

- Updated dependencies [3b88f66]
  - @cat-factory/kernel@0.221.0
  - @cat-factory/agents@0.106.5

## 0.2.20

### Patch Changes

- Updated dependencies [7f86f07]
  - @cat-factory/kernel@0.220.0
  - @cat-factory/agents@0.106.4

## 0.2.19

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/kernel@0.219.0
  - @cat-factory/agents@0.106.3

## 0.2.18

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/kernel@0.218.0
  - @cat-factory/agents@0.106.2

## 0.2.17

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/kernel@0.217.0
  - @cat-factory/agents@0.106.1

## 0.2.16

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/kernel@0.216.0
  - @cat-factory/agents@0.106.0

## 0.2.15

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/kernel@0.215.0
  - @cat-factory/agents@0.105.0

## 0.2.14

### Patch Changes

- @cat-factory/agents@0.104.3
- @cat-factory/kernel@0.214.1

## 0.2.13

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0
  - @cat-factory/agents@0.104.2

## 0.2.12

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0
  - @cat-factory/agents@0.104.1

## 0.2.11

### Patch Changes

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/agents@0.104.0

## 0.2.10

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0
  - @cat-factory/agents@0.103.0

## 0.2.9

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/kernel@0.210.0
  - @cat-factory/agents@0.102.0

## 0.2.8

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/kernel@0.209.0
  - @cat-factory/agents@0.101.0

## 0.2.7

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/kernel@0.208.0
  - @cat-factory/agents@0.100.0

## 0.2.6

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/kernel@0.207.0
  - @cat-factory/agents@0.99.0

## 0.2.5

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/agents@0.98.0

## 0.2.4

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/kernel@0.205.0
  - @cat-factory/agents@0.97.0

## 0.2.3

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/kernel@0.204.0
  - @cat-factory/agents@0.96.1

## 0.2.2

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/kernel@0.203.0
  - @cat-factory/agents@0.96.0

## 0.2.1

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0
  - @cat-factory/agents@0.95.1

## 0.2.0

### Minor Changes

- 54e6a45: Agent-kind variants: register an alternate prompt for an EXISTING kind programmatically

  `AgentKindRegistry.registerVariant({ id, baseKind, systemPrompt | promptAddition })` lets a
  deployment ship "the Coder, but test-first" without inventing an agent kind. A pipeline step
  selects one through `stepOptions.agentVariantId`, so the step still records the base kind and every
  behavioural decision — dispatch shape, guardrails, companions, gating, the palette — is unchanged;
  only the prompt differs. The engine resolves the variant in the same once-per-dispatch place as a
  per-workspace prompt override and emits it through the same field, so the engine-enforced
  directives still apply on top and a workspace override still wins as the narrower tier.

  Because the workspace wins on the same unit of text, selecting a variant is not proof it ran: the
  dispatch pins what it actually did onto `PipelineStep.promptVariant` (`full` / `addition-only` /
  `superseded` / `withdrawn`, plus a fingerprint of the text the variant contributed) and warns on
  every losing disposition. The run views and Kaizen's combo key both read that pin rather than the
  step's selection, so a step is never reported as running a variation whose text never reached it, and
  re-wording a variant under the same id starts a fresh verification streak instead of inheriting the
  previous wording's.

  Varying an INLINE-ENGINE kind (the requirements + clarity reviewers, the brainstorm stages, their
  rework editors) is refused at boot and at pipeline save rather than accepted and ignored: those kinds
  compose their prompt without a step, so the variant could never reach the model. Vary them with a
  per-workspace prompt override instead. `merger` and `on-call` are unaffected — they dispatch through
  the engine, so a variant applies to their role half.

  The two bespoke container prompts (`merger`, `on-call`) moved from `@cat-factory/server` into
  `@cat-factory/agents` alongside the inline-engine ones, and `builtInBaseSystemPrompt` is now
  `shippedBasePromptFor` exported from there.

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/agents@0.95.0
  - @cat-factory/kernel@0.201.1

## 0.1.145

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/agents@0.94.0
  - @cat-factory/kernel@0.201.0

## 0.1.144

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/kernel@0.200.0
  - @cat-factory/agents@0.93.0

## 0.1.143

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/kernel@0.199.0
  - @cat-factory/agents@0.92.0

## 0.1.142

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/agents@0.91.0

## 0.1.141

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/agents@0.90.0
  - @cat-factory/kernel@0.197.0

## 0.1.140

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/kernel@0.196.0
  - @cat-factory/agents@0.89.1

## 0.1.139

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0
  - @cat-factory/agents@0.89.0

## 0.1.138

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/agents@0.88.0
  - @cat-factory/kernel@0.194.0

## 0.1.137

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/kernel@0.193.0
  - @cat-factory/agents@0.87.2

## 0.1.136

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/agents@0.87.1

## 0.1.135

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/kernel@0.191.0
  - @cat-factory/agents@0.87.0

## 0.1.134

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0
  - @cat-factory/agents@0.86.0

## 0.1.133

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/kernel@0.189.0
  - @cat-factory/agents@0.85.0

## 0.1.132

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/kernel@0.188.0
  - @cat-factory/agents@0.84.2

## 0.1.131

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/kernel@0.187.0
  - @cat-factory/agents@0.84.1

## 0.1.130

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/kernel@0.186.0
  - @cat-factory/agents@0.84.0

## 0.1.129

### Patch Changes

- @cat-factory/agents@0.83.1
- @cat-factory/kernel@0.185.1

## 0.1.128

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0
  - @cat-factory/agents@0.83.0

## 0.1.127

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0
  - @cat-factory/agents@0.82.4

## 0.1.126

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/kernel@0.183.0
  - @cat-factory/agents@0.82.3

## 0.1.125

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/kernel@0.182.0
  - @cat-factory/agents@0.82.2

## 0.1.124

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/kernel@0.181.0
  - @cat-factory/agents@0.82.1

## 0.1.123

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0
  - @cat-factory/agents@0.82.0

## 0.1.122

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/kernel@0.179.0
  - @cat-factory/agents@0.81.1

## 0.1.121

### Patch Changes

- Updated dependencies [9d965c9]
- Updated dependencies [8a9f311]
  - @cat-factory/kernel@0.178.0
  - @cat-factory/agents@0.81.0

## 0.1.120

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/kernel@0.177.0
  - @cat-factory/agents@0.80.1

## 0.1.119

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/agents@0.80.0
  - @cat-factory/kernel@0.176.0

## 0.1.118

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/kernel@0.175.0
  - @cat-factory/agents@0.79.0

## 0.1.117

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/kernel@0.174.0
  - @cat-factory/agents@0.78.0

## 0.1.116

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/kernel@0.173.0
  - @cat-factory/agents@0.77.1

## 0.1.115

### Patch Changes

- Updated dependencies [a04f609]
  - @cat-factory/agents@0.77.0

## 0.1.114

### Patch Changes

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/kernel@0.172.0
  - @cat-factory/agents@0.76.0

## 0.1.113

### Patch Changes

- Updated dependencies [3260f2d]
  - @cat-factory/agents@0.75.2

## 0.1.112

### Patch Changes

- Updated dependencies [15905ab]
- Updated dependencies [9d8fe9b]
  - @cat-factory/agents@0.75.1
  - @cat-factory/kernel@0.171.0

## 0.1.111

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/agents@0.75.0
  - @cat-factory/kernel@0.170.0

## 0.1.110

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/kernel@0.169.0
  - @cat-factory/agents@0.74.1

## 0.1.109

### Patch Changes

- Updated dependencies [fb71506]
  - @cat-factory/agents@0.74.0

## 0.1.108

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/kernel@0.168.0
  - @cat-factory/agents@0.73.2

## 0.1.107

### Patch Changes

- @cat-factory/agents@0.73.1
- @cat-factory/kernel@0.167.1

## 0.1.106

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/agents@0.73.0
  - @cat-factory/kernel@0.167.0

## 0.1.105

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/kernel@0.166.0
  - @cat-factory/agents@0.72.3

## 0.1.104

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1
  - @cat-factory/agents@0.72.2

## 0.1.103

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/kernel@0.165.0
  - @cat-factory/agents@0.72.1

## 0.1.102

### Patch Changes

- Updated dependencies [640cadd]
  - @cat-factory/kernel@0.164.0
  - @cat-factory/agents@0.72.0

## 0.1.101

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/agents@0.71.0
  - @cat-factory/kernel@0.163.1

## 0.1.100

### Patch Changes

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/agents@0.70.1
  - @cat-factory/kernel@0.163.0

## 0.1.99

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/agents@0.70.0
  - @cat-factory/kernel@0.162.0

## 0.1.98

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/kernel@0.161.0
  - @cat-factory/agents@0.69.10

## 0.1.97

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/agents@0.69.9

## 0.1.96

### Patch Changes

- @cat-factory/agents@0.69.8
- @cat-factory/kernel@0.159.1

## 0.1.95

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0
  - @cat-factory/agents@0.69.7

## 0.1.94

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/kernel@0.158.0
  - @cat-factory/agents@0.69.6

## 0.1.93

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/agents@0.69.5

## 0.1.92

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/kernel@0.156.0
  - @cat-factory/agents@0.69.4

## 0.1.91

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/agents@0.69.3

## 0.1.90

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/agents@0.69.2

## 0.1.89

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/agents@0.69.1
  - @cat-factory/kernel@0.154.1

## 0.1.88

### Patch Changes

- Updated dependencies [ce1ce11]
  - @cat-factory/agents@0.69.0

## 0.1.87

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/agents@0.68.4

## 0.1.86

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/kernel@0.153.0
  - @cat-factory/agents@0.68.3

## 0.1.85

### Patch Changes

- Updated dependencies [8254367]
  - @cat-factory/agents@0.68.2

## 0.1.84

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/kernel@0.152.0
  - @cat-factory/agents@0.68.1

## 0.1.83

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0

## 0.1.82

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/agents@0.67.9

## 0.1.81

### Patch Changes

- Updated dependencies [2cfae1e]
  - @cat-factory/agents@0.67.8

## 0.1.80

### Patch Changes

- Updated dependencies [3c7d62b]
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7

## 0.1.79

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/kernel@0.149.0
  - @cat-factory/agents@0.67.6

## 0.1.78

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/agents@0.67.5

## 0.1.77

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/kernel@0.148.4
  - @cat-factory/agents@0.67.4

## 0.1.76

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3

## 0.1.75

### Patch Changes

- @cat-factory/agents@0.67.2

## 0.1.74

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/kernel@0.148.2
  - @cat-factory/agents@0.67.1

## 0.1.73

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/agents@0.67.0
  - @cat-factory/kernel@0.148.1

## 0.1.72

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/kernel@0.148.0
  - @cat-factory/agents@0.66.7

## 0.1.71

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/agents@0.66.6

## 0.1.70

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5

## 0.1.69

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/kernel@0.147.2
  - @cat-factory/agents@0.66.4

## 0.1.68

### Patch Changes

- Updated dependencies [972a1bd]
  - @cat-factory/agents@0.66.3

## 0.1.67

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/agents@0.66.2

## 0.1.66

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/agents@0.66.1

## 0.1.65

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0

## 0.1.64

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/agents@0.65.5

## 0.1.63

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/agents@0.65.4

## 0.1.62

### Patch Changes

- @cat-factory/agents@0.65.3
- @cat-factory/kernel@0.145.1

## 0.1.61

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/kernel@0.145.0
  - @cat-factory/agents@0.65.2

## 0.1.60

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/kernel@0.144.0
  - @cat-factory/agents@0.65.1

## 0.1.59

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/kernel@0.143.0
  - @cat-factory/agents@0.65.0

## 0.1.58

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/agents@0.64.2

## 0.1.57

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/agents@0.64.1

## 0.1.56

### Patch Changes

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0

## 0.1.55

### Patch Changes

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0

## 0.1.54

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/agents@0.62.13

## 0.1.53

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/agents@0.62.12

## 0.1.52

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/agents@0.62.11
  - @cat-factory/kernel@0.139.3

## 0.1.51

### Patch Changes

- @cat-factory/agents@0.62.10
- @cat-factory/kernel@0.139.2

## 0.1.50

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/kernel@0.139.1
  - @cat-factory/agents@0.62.9

## 0.1.49

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/kernel@0.139.0
  - @cat-factory/agents@0.62.8

## 0.1.48

### Patch Changes

- @cat-factory/agents@0.62.7
- @cat-factory/kernel@0.138.1

## 0.1.47

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/kernel@0.138.0
  - @cat-factory/agents@0.62.6

## 0.1.46

### Patch Changes

- @cat-factory/agents@0.62.5
- @cat-factory/kernel@0.137.1

## 0.1.45

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/agents@0.62.4

## 0.1.44

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/kernel@0.136.0
  - @cat-factory/agents@0.62.3

## 0.1.43

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/agents@0.62.2

## 0.1.42

### Patch Changes

- @cat-factory/agents@0.62.1
- @cat-factory/kernel@0.134.1

## 0.1.41

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0

## 0.1.40

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/agents@0.61.2

## 0.1.39

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0
  - @cat-factory/agents@0.61.1

## 0.1.38

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/agents@0.61.0

## 0.1.37

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0

## 0.1.36

### Patch Changes

- @cat-factory/agents@0.59.2
- @cat-factory/kernel@0.129.2

## 0.1.35

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1
  - @cat-factory/agents@0.59.1

## 0.1.34

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0

## 0.1.33

### Patch Changes

- @cat-factory/agents@0.58.1
- @cat-factory/kernel@0.128.1

## 0.1.32

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/agents@0.58.0

## 0.1.31

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0

## 0.1.30

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0

## 0.1.29

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0

## 0.1.28

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/agents@0.54.12

## 0.1.27

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/kernel@0.123.3
  - @cat-factory/agents@0.54.11

## 0.1.26

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/agents@0.54.10

## 0.1.25

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1
  - @cat-factory/agents@0.54.9

## 0.1.24

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/agents@0.54.8

## 0.1.23

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/kernel@0.122.0
  - @cat-factory/agents@0.54.7

## 0.1.22

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8
  - @cat-factory/agents@0.54.6

## 0.1.21

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/agents@0.54.5

## 0.1.20

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/agents@0.54.4

## 0.1.19

### Patch Changes

- Updated dependencies [f8f1aa8]
  - @cat-factory/agents@0.54.3
  - @cat-factory/kernel@0.121.5

## 0.1.18

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/agents@0.54.2

## 0.1.17

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/agents@0.54.1

## 0.1.16

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/agents@0.54.0
  - @cat-factory/kernel@0.121.2

## 0.1.15

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/agents@0.53.6

## 0.1.14

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/agents@0.53.5

## 0.1.13

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4

## 0.1.12

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/agents@0.53.3

## 0.1.11

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0
  - @cat-factory/agents@0.53.2

## 0.1.10

### Patch Changes

- @cat-factory/agents@0.53.1
- @cat-factory/kernel@0.118.1

## 0.1.9

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0

## 0.1.8

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/kernel@0.117.6
  - @cat-factory/agents@0.52.9

## 0.1.7

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/agents@0.52.8

## 0.1.6

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/kernel@0.117.4
  - @cat-factory/agents@0.52.7

## 0.1.5

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/agents@0.52.6

## 0.1.4

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/agents@0.52.5

## 0.1.3

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1
  - @cat-factory/agents@0.52.4

## 0.1.2

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/agents@0.52.3

## 0.1.1

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/agents@0.52.2

## 0.1.0

### Minor Changes

- 95dc91f: Worked example: a `preset_org_research` "research → apply" initiative preset (custom-initiative
  slice 6, the acceptance proof).

  The `example-custom-agent` package gains a minimal two-phase "research → apply" initiative preset
  that exercises every seam the custom-initiative-definitions initiative added: a `checkpoint: true`
  research phase (the initiative pauses after the research merges so a human reads the committed
  report and resumes on GO / cancels on NO_GO), a custom structured `org-researcher` kind with a
  verdict step resolver and an artifact post-op running on a merging pipeline (`pl_org_research`),
  spawned-run prompt steering for the built-in `coder` and the custom research kind, and a
  `seedPlan`-derived report path stamped on the research item (producer) and baked into the apply
  item's description (consumer). It proves a deployment can assemble a proprietary multi-phase
  methodology from the public seams alone — no engine or facade change. `pl_org_research` /
  `pl_org_apply` pipelines and `registerOrgResearchPreset` are new exports.

## 0.0.182

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1
  - @cat-factory/agents@0.52.1

## 0.0.181

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0

## 0.0.180

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0

## 0.0.179

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0

## 0.0.178

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/kernel@0.112.1

## 0.0.177

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/agents@0.49.2

## 0.0.176

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/agents@0.49.1
  - @cat-factory/kernel@0.111.1

## 0.0.175

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0

## 0.0.174

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/agents@0.48.5
  - @cat-factory/kernel@0.110.1

## 0.0.173

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/agents@0.48.4
  - @cat-factory/kernel@0.110.0

## 0.0.172

### Patch Changes

- Updated dependencies [35636d5]
  - @cat-factory/agents@0.48.3

## 0.0.171

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/agents@0.48.2

## 0.0.170

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/kernel@0.109.0
  - @cat-factory/agents@0.48.1

## 0.0.169

### Patch Changes

- 629cf90: Initiative presets slice 9: the E2E baseline + a worked-example deployment preset.

  - `@cat-factory/conformance`: `FakeAgentExecutor` gains an `initiativePlan` option so a
    fake-driven initiative-planner step returns a plan draft (the planner otherwise faults a
    planning run) — the seam an e2e/integration test uses to drive create-with-preset → auto-plan
    → spawn.
  - `@cat-factory/node-server`: the initiative-loop sweep interval is now overridable via
    `INITIATIVE_LOOP_INTERVAL_MS` (default 60s unchanged).
  - `@cat-factory/app`: `TaskCard` exposes a behaviour-neutral `data-task-type` attribute (the e2e
    asserts a spawned document task carries its preset decoration).
  - `@cat-factory/example-custom-agent`: adds `preset_org_audit`, a worked-example initiative preset
    registered through the public `registerInitiativePreset` seam.

## 0.0.168

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0

## 0.0.167

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0

## 0.0.166

### Patch Changes

- Updated dependencies [cb088c7]
  - @cat-factory/agents@0.46.0

## 0.0.165

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0

## 0.0.164

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1

## 0.0.163

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0

## 0.0.162

### Patch Changes

- @cat-factory/agents@0.43.1

## 0.0.161

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0

## 0.0.160

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0

## 0.0.159

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0

## 0.0.158

### Patch Changes

- @cat-factory/agents@0.40.13
- @cat-factory/kernel@0.104.4

## 0.0.157

### Patch Changes

- @cat-factory/agents@0.40.12
- @cat-factory/kernel@0.104.3

## 0.0.156

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11

## 0.0.155

### Patch Changes

- @cat-factory/agents@0.40.10
- @cat-factory/kernel@0.104.1

## 0.0.154

### Patch Changes

- Updated dependencies [37d1517]
  - @cat-factory/kernel@0.104.0
  - @cat-factory/agents@0.40.9

## 0.0.153

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/kernel@0.103.0
  - @cat-factory/agents@0.40.8

## 0.0.152

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/kernel@0.102.0
  - @cat-factory/agents@0.40.7

## 0.0.151

### Patch Changes

- @cat-factory/agents@0.40.6
- @cat-factory/kernel@0.101.2

## 0.0.150

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/kernel@0.101.1
  - @cat-factory/agents@0.40.5

## 0.0.149

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/kernel@0.101.0
  - @cat-factory/agents@0.40.4

## 0.0.148

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/kernel@0.100.0
  - @cat-factory/agents@0.40.3

## 0.0.147

### Patch Changes

- @cat-factory/agents@0.40.2
- @cat-factory/kernel@0.99.1

## 0.0.146

### Patch Changes

- Updated dependencies [1afa003]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/agents@0.40.1

## 0.0.145

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0

## 0.0.144

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/kernel@0.97.0
  - @cat-factory/agents@0.39.4

## 0.0.143

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [dd6df12]
  - @cat-factory/kernel@0.96.0
  - @cat-factory/agents@0.39.3

## 0.0.142

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/kernel@0.95.0
  - @cat-factory/agents@0.39.2

## 0.0.141

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/kernel@0.94.0
  - @cat-factory/agents@0.39.1

## 0.0.140

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/agents@0.39.0
  - @cat-factory/kernel@0.93.0

## 0.0.139

### Patch Changes

- Updated dependencies [029a689]
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2

## 0.0.138

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1

## 0.0.137

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0

## 0.0.136

### Patch Changes

- @cat-factory/agents@0.37.2
- @cat-factory/kernel@0.89.1

## 0.0.135

### Patch Changes

- Updated dependencies [cfcb6c7]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/agents@0.37.1

## 0.0.134

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0

## 0.0.133

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0

## 0.0.132

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/agents@0.35.0
  - @cat-factory/kernel@0.86.1

## 0.0.131

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/kernel@0.86.0
  - @cat-factory/agents@0.34.0

## 0.0.130

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/agents@0.33.1

## 0.0.129

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/agents@0.33.0

## 0.0.128

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/agents@0.32.0

## 0.0.127

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0

## 0.0.126

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/kernel@0.82.0
  - @cat-factory/agents@0.30.5

## 0.0.125

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/kernel@0.81.0
  - @cat-factory/agents@0.30.4

## 0.0.124

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/kernel@0.80.0
  - @cat-factory/agents@0.30.3

## 0.0.123

### Patch Changes

- @cat-factory/agents@0.30.2
- @cat-factory/kernel@0.79.1

## 0.0.122

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/kernel@0.79.0
  - @cat-factory/agents@0.30.1

## 0.0.121

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/kernel@0.78.0
  - @cat-factory/agents@0.30.0

## 0.0.120

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/kernel@0.77.0
  - @cat-factory/agents@0.29.1

## 0.0.119

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0

## 0.0.118

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0

## 0.0.117

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1

## 0.0.116

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/agents@0.27.0

## 0.0.115

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/agents@0.26.18

## 0.0.114

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/kernel@0.72.0
  - @cat-factory/agents@0.26.17

## 0.0.113

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/kernel@0.71.0
  - @cat-factory/agents@0.26.16

## 0.0.112

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/kernel@0.70.2
  - @cat-factory/agents@0.26.15

## 0.0.111

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1
  - @cat-factory/agents@0.26.14

## 0.0.110

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0
  - @cat-factory/agents@0.26.13

## 0.0.109

### Patch Changes

- @cat-factory/agents@0.26.12
- @cat-factory/kernel@0.69.8

## 0.0.108

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/agents@0.26.11

## 0.0.107

### Patch Changes

- Updated dependencies [4955639]
  - @cat-factory/agents@0.26.10

## 0.0.106

### Patch Changes

- @cat-factory/agents@0.26.9
- @cat-factory/kernel@0.69.6

## 0.0.105

### Patch Changes

- @cat-factory/agents@0.26.8
- @cat-factory/kernel@0.69.5

## 0.0.104

### Patch Changes

- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7

## 0.0.103

### Patch Changes

- @cat-factory/agents@0.26.6
- @cat-factory/kernel@0.69.4

## 0.0.102

### Patch Changes

- @cat-factory/agents@0.26.5
- @cat-factory/kernel@0.69.3

## 0.0.101

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/agents@0.26.4

## 0.0.100

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/kernel@0.69.1
  - @cat-factory/agents@0.26.3

## 0.0.99

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/kernel@0.69.0
  - @cat-factory/agents@0.26.2

## 0.0.98

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/kernel@0.68.1
  - @cat-factory/agents@0.26.1

## 0.0.97

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0

## 0.0.96

### Patch Changes

- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [6c51e31]
- Updated dependencies [33687cf]
  - @cat-factory/kernel@0.67.0
  - @cat-factory/agents@0.25.0

## 0.0.95

### Patch Changes

- @cat-factory/agents@0.24.16
- @cat-factory/kernel@0.66.1

## 0.0.94

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/agents@0.24.15

## 0.0.93

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/kernel@0.65.0
  - @cat-factory/agents@0.24.14

## 0.0.92

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/kernel@0.64.0
  - @cat-factory/agents@0.24.13

## 0.0.91

### Patch Changes

- @cat-factory/agents@0.24.12
- @cat-factory/kernel@0.63.4

## 0.0.90

### Patch Changes

- @cat-factory/agents@0.24.11
- @cat-factory/kernel@0.63.3

## 0.0.89

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/kernel@0.63.2
  - @cat-factory/agents@0.24.10

## 0.0.88

### Patch Changes

- @cat-factory/agents@0.24.9
- @cat-factory/kernel@0.63.1

## 0.0.87

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/agents@0.24.8

## 0.0.86

### Patch Changes

- @cat-factory/agents@0.24.7
- @cat-factory/kernel@0.62.4

## 0.0.85

### Patch Changes

- @cat-factory/agents@0.24.6
- @cat-factory/kernel@0.62.3

## 0.0.84

### Patch Changes

- @cat-factory/agents@0.24.5
- @cat-factory/kernel@0.62.2

## 0.0.83

### Patch Changes

- @cat-factory/agents@0.24.4
- @cat-factory/kernel@0.62.1

## 0.0.82

### Patch Changes

- Updated dependencies [858799e]
  - @cat-factory/kernel@0.62.0
  - @cat-factory/agents@0.24.3

## 0.0.81

### Patch Changes

- @cat-factory/agents@0.24.2
- @cat-factory/kernel@0.61.1

## 0.0.80

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/kernel@0.61.0
  - @cat-factory/agents@0.24.1

## 0.0.79

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/agents@0.24.0

## 0.0.78

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/agents@0.23.4

## 0.0.77

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/agents@0.23.3

## 0.0.76

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/kernel@0.57.1

## 0.0.75

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/kernel@0.57.0
  - @cat-factory/agents@0.23.1

## 0.0.74

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/agents@0.23.0
  - @cat-factory/kernel@0.56.1

## 0.0.73

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/kernel@0.56.0
  - @cat-factory/agents@0.22.6

## 0.0.72

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/agents@0.22.5

## 0.0.71

### Patch Changes

- @cat-factory/agents@0.22.4
- @cat-factory/kernel@0.55.3

## 0.0.70

### Patch Changes

- @cat-factory/agents@0.22.3
- @cat-factory/kernel@0.55.2

## 0.0.69

### Patch Changes

- @cat-factory/agents@0.22.2
- @cat-factory/kernel@0.55.1

## 0.0.68

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/agents@0.22.1

## 0.0.67

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/agents@0.22.0

## 0.0.66

### Patch Changes

- @cat-factory/agents@0.21.17
- @cat-factory/kernel@0.53.1

## 0.0.65

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/kernel@0.53.0
  - @cat-factory/agents@0.21.16

## 0.0.64

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/agents@0.21.15

## 0.0.63

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/kernel@0.51.0
  - @cat-factory/agents@0.21.14

## 0.0.62

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/kernel@0.50.0
  - @cat-factory/agents@0.21.13

## 0.0.61

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/kernel@0.49.0
  - @cat-factory/agents@0.21.12

## 0.0.60

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/kernel@0.48.0
  - @cat-factory/agents@0.21.11

## 0.0.59

### Patch Changes

- @cat-factory/agents@0.21.10
- @cat-factory/kernel@0.47.2

## 0.0.58

### Patch Changes

- @cat-factory/agents@0.21.9
- @cat-factory/kernel@0.47.1

## 0.0.57

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/agents@0.21.8

## 0.0.56

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/agents@0.21.7

## 0.0.55

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/kernel@0.45.5
  - @cat-factory/agents@0.21.6

## 0.0.54

### Patch Changes

- @cat-factory/agents@0.21.5
- @cat-factory/kernel@0.45.4

## 0.0.53

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/agents@0.21.4

## 0.0.52

### Patch Changes

- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/kernel@0.45.2

## 0.0.51

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1
  - @cat-factory/agents@0.21.2

## 0.0.50

### Patch Changes

- Updated dependencies [eab73b8]
  - @cat-factory/kernel@0.45.0
  - @cat-factory/agents@0.21.1

## 0.0.49

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0

## 0.0.48

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/agents@0.20.3

## 0.0.47

### Patch Changes

- @cat-factory/agents@0.20.2
- @cat-factory/kernel@0.42.2

## 0.0.46

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1

## 0.0.45

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/agents@0.20.0

## 0.0.44

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0

## 0.0.43

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/kernel@0.40.0
  - @cat-factory/agents@0.18.5

## 0.0.42

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/kernel@0.39.0
  - @cat-factory/agents@0.18.4

## 0.0.41

### Patch Changes

- @cat-factory/agents@0.18.3
- @cat-factory/kernel@0.38.1

## 0.0.40

### Patch Changes

- Updated dependencies [692ccb4]
  - @cat-factory/agents@0.18.2

## 0.0.39

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/kernel@0.38.0
  - @cat-factory/agents@0.18.1

## 0.0.38

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/agents@0.18.0

## 0.0.37

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/kernel@0.36.0
  - @cat-factory/agents@0.17.2

## 0.0.36

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/kernel@0.35.0
  - @cat-factory/agents@0.17.1

## 0.0.35

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0

## 0.0.34

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1

## 0.0.33

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0

## 0.0.32

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/kernel@0.32.0
  - @cat-factory/agents@0.15.2

## 0.0.31

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/agents@0.15.1

## 0.0.30

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/agents@0.15.0

## 0.0.29

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/agents@0.14.9

## 0.0.28

### Patch Changes

- @cat-factory/agents@0.14.8
- @cat-factory/kernel@0.28.1

## 0.0.27

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/kernel@0.28.0
  - @cat-factory/agents@0.14.7

## 0.0.26

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/kernel@0.27.0
  - @cat-factory/agents@0.14.6

## 0.0.25

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/agents@0.14.5

## 0.0.24

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/agents@0.14.4

## 0.0.23

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/agents@0.14.3

## 0.0.22

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/kernel@0.24.0
  - @cat-factory/agents@0.14.2

## 0.0.21

### Patch Changes

- 7346a4f: Make the polling **Gate** and **StepCompletionResolver** mechanisms externally
  extensible, so a company-authored deployment package can register its OWN full-blown gate
  (deterministic probe + helper/companion agent + exhaustion handling) or step resolver
  purely via an import side effect — exactly the way it already registers a custom agent
  kind. No fork, no engine patch, and no executor-harness image change (pure backend TS).

  - **kernel**: new `domain/gate-registry.ts` (`registerGate(kind, factory)` +
    `GateDefinition`/`GateContext`/`GateProbe`/`recordGateAttempt`/…) and
    `domain/step-resolver-registry.ts` (`registerStepResolver(kind, factory)` +
    `StepCompletionResolver`/`ResolverContext`/…), moved out of orchestration so an
    extension package depends only on kernel + agents. `RaiseNotificationInput` moved to
    `ports/notification-channel.ts` so the runtime-neutral `GateContext` can build one. A
    registered gate/resolver is a `(ctx) => Definition` factory the engine invokes once at
    registry-build time — solving the `this`-capture the built-in gates rely on while
    keeping them inline and unchanged.
  - **orchestration**: `ExecutionService.buildGateRegistry()` /
    `buildStepResolverRegistry()` now merge the deployment-registered factories with the
    built-ins (registered replaces built-in of the same kind, last-wins) via new
    `makeGateContext()`/`makeResolverContext()` seams; the gate/resolver types are
    re-exported from the package index for discovery.
  - **example-custom-agent**: registers a `license-check` gate (escalating to a new
    `license-fixer` agent kind) + an auditor step resolver + a `wireLicenseProvider` seam,
    proving a custom gate ships with zero engine changes.
  - **conformance**: a new cross-runtime assertion drives a registered custom gate
    (pass-through, escalate-then-pass) and a registered step resolver on both runtimes.

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/agents@0.14.1

## 0.0.20

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0

## 0.0.19

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0

## 0.0.18

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0

## 0.0.17

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/kernel@0.19.0
  - @cat-factory/agents@0.11.16

## 0.0.16

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/kernel@0.18.0
  - @cat-factory/agents@0.11.15

## 0.0.15

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/kernel@0.17.0
  - @cat-factory/agents@0.11.14

## 0.0.14

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13

## 0.0.13

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/kernel@0.16.1
  - @cat-factory/agents@0.11.12

## 0.0.12

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/agents@0.11.11

## 0.0.11

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1
  - @cat-factory/agents@0.11.10

## 0.0.10

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/agents@0.11.9

## 0.0.9

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/agents@0.11.8

## 0.0.8

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/kernel@0.14.0
  - @cat-factory/agents@0.11.7

## 0.0.7

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/kernel@0.13.4

## 0.0.6

### Patch Changes

- @cat-factory/agents@0.11.5
- @cat-factory/kernel@0.13.3

## 0.0.5

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4

## 0.0.4

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1
  - @cat-factory/agents@0.11.3

## 0.0.3

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/kernel@0.13.0
  - @cat-factory/agents@0.11.2

## 0.0.2

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/agents@0.11.1

## 0.0.1

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
