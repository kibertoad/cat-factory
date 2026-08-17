# Sandbox coverage expansion

Widening the Sandbox (the in-product prompt/model testing surface) from four inline reviewer kinds
to the full set of agent kinds worth comparing, and settling how a fixture that needs a repository
is going to work.

## Goal

The Sandbox answers two questions: "which model is best for this task?" and "does a better prompt
help?". It can only answer either one honestly if a cell sends the prompt production sends, grades
it on a rubric that matches the task, and covers the kinds people actually tune. When this
initiative opened it did none of those three reliably.

## Why now

Three defects, each of which makes a Sandbox score quietly wrong rather than absent:

1. **The task input was an approximation.** The system half of every cell was composed through the
   production path, but the USER half was hand-rolled from the fixture payload: a title, a
   description, and any prior outputs. For `requirements-review` that dropped the JSON output
   contract, the product-scope test and the `autoAnswerable` classification, which is most of what
   the shipped prompt is about, and the cell was then graded on a rubric that scores exactly those.
2. **The baseline text was the composed prompt, not the editable unit.** `baselinePromptText` read
   `PROMPT_VERSIONS[id].text`, which for the inline ENGINE kinds is `role + directives`. So a
   candidate cloned from the `requirements-review` baseline already carried the directives, and
   promoting that candidate to the live workspace prompt doubled them, which is precisely the
   failure the package's own AGENTS.md says the design avoids.
3. **Two kinds were graded on the wrong rubric.** `clarity-review` (bug triage) and
   `architect-companion` (design critique) both ran against `requirement-review`, whose
   `product_scope` dimension DOCKS a finding for being technical. Those two stages exist to raise
   technical findings, so the rubric penalised their highest-value output: the fixtures' own
   headline expectations (session affinity, partition keys, cache durability) were the ones it
   marked down.

## Target pattern

- **One task-input builder per agent kind, delegating to the pure prompt builder its production
  caller uses.** `orchestration/modules/sandbox/sandbox-input.ts`; there is deliberately no generic
  fallback, because an unknown kind is refused at launch and a fallback could only mean "silently
  grade a different task".
- **`composedSystemPromptFor(kind, registry, replacement)`** in `@cat-factory/agents` is the one
  place that decides bespoke-vs-composed. Container dispatch
  (`dispatchSystemPromptFor`) and the Sandbox both ride it, and `shippedBasePromptFor` is its
  inverse: what an override replaces.
- **A catalog entry answers the two execution questions separately.** `bucket` is how PRODUCTION
  dispatches the kind; `sandboxRun` is how the Sandbox runs a cell for it; `unsupportedReason` is
  the single bounded CODE the create endpoint, the run-driver and the SPA's excluded-kind note all
  read, each wording it for its own reader.
- **A container kind the Sandbox runs inline is TOLD it has no checkout** (`statesMissingCheckout`
  plus the run-driver's evaluation note). Its composed system prompt was written for an agent
  holding a real clone.
- **A repo-scale change reaches an inline cell on `injectedContextFiles`**, the production seam for
  a caller with no filesystem (`withInjectedContext`).

## Committed scope

All of the below landed in [#2037](https://github.com/kibertoad/cat-factory/pull/2037) unless
another PR is named.

- [x] Route every cell's task input through the production prompt builder, `ownService` included
      (production sets it on every dispatch, and `ownServiceSection` renders the ABSENCE, so
      leaving it unset graded three kinds on a prompt production never sends)
- [x] Fix the baseline text to the promotable unit, and hoist the composition branch into
      `@cat-factory/agents`
- [x] `architecture-review`, `bug-triage`, `estimation` and `answer-recommendation` rubrics;
      re-map `clarity-review` and `architect-companion`
- [x] `task-estimator` and `requirements-writer` catalog entries, with fixture kinds and fixtures
- [x] Split `bucket` from `sandboxRun`, with one home for the refusal (a bounded CODE the SPA
      translates), refused at CREATE as well as launch, and the fixture↔kind pairing refused at both
- [x] A repo-scale (multi-file) reviewer fixture, delivered as injected context files
- [x] Explicit `*` prefix marker on `matchHints` (a bare stem was a dead hint: the scorer compares
      tokens by equality, so `idempoten` never matched `idempotent` and scored "missed" for every
      answer)
- [x] Reconcile the builtin fixture library against the CATALOG on every read, rather than seeding
      once when the workspace has none
- [ ] Container cells, for the kinds whose deliverable is a pushed commit. See the decision below:
      the route is a deployment-owned seed repository, NOT an injected fake. **Their dispatch must
      suppress the workspace prompt override** (see the gotchas).
- [ ] Durable fan-out for the matrix. `launch` drives every cell inline in the request today,
      bounded by the cell cap and the token budget. A large matrix belongs on Workflows / pg-boss
      like execution and bootstrap.

## Decision: no injected "fake" repositories in the executors

The open question this initiative had to settle was whether a repo fixture could synthesise its
repository inside the container instead of pointing at a real one. **It cannot, and should not.**
Recorded here so the next iteration does not re-propose it.

What made it look feasible: the harness already accepts a `file://` clone URL (`assertAllowedHost`
permits it, since no token leaves the box), so a job could in principle carry a set of seed files,
have the harness `git init` them, and clone from there.

Why it is the wrong design anyway:

- **It fakes exactly what the measurement is about.** A `coder` cell has to be graded on a pushed
  diff against a base. With no remote there is no PR, no CI, and no checkpoint push (the harness
  publishes commits as it makes them, which is invisible from inside the container and is why the
  delivery contract tells the agent not to amend). So the graded run diverges from production at
  the exact point the grade is supposed to be about.
- **It puts a permanent surface on the harness contract for one non-production caller.** Every
  fixture's repository state would have to ride the job body, and the harness's rule is that it
  MATERIALISES and never decides. Worse, every change to that field is an image bump plus a pin
  update everywhere the tag appears, for a field only the Sandbox sends.
- **A `git init` seed has no history**, so `git log`, `git diff base...head` and `git show
origin/pr-head:<path>` (all of which the coder, merger and pr-reviewer prompts name explicitly)
  behave differently from a real checkout. A fixture that only works because the agent avoided
  those commands is measuring avoidance.
- **The cost shape is wrong.** The cell cap is 100. A hundred containers per experiment is a fleet,
  not a comparison harness, and each one pays a cold start before the model does anything.

**The supported route is a deployment-owned seed repository**, which is what `SandboxRepoRef`
(`owner` / `name` / `seedRef`) already models: a repository the deployment owns, pinned at a tag or
SHA so a cell is reproducible, cloned exactly as a real run clones. The remaining work is the run
side (container dispatch from a Sandbox cell, ephemeral branch cleanup, diff capture), not the
fixture side. A deployment can author such a fixture through `POST /sandbox/fixtures` today; the
create and launch doors both refuse to RUN one, naming that route.

**"Bootstrap an empty repository" is not an alternative to it, and is worth saying why.** The
platform already has a bootstrap flow, and an empty repo makes a legitimate fixture class (a
greenfield task). But a fixture is only a benchmark if it is reproducible and if the interesting
cases can be expressed, and an empty repository can express neither "fix this bug in this code" nor
"make this change without breaking that caller", which is the entire bug-and-feature range the
`implementation` rubric grades. So it is a fallback for a deployment with no fixture repository, not
the design.

**What we do instead, now.** For every kind whose input is a repository READ rather than a
repository WRITE, the change arrives as injected context files, which is not a workaround: it is the
same field the `pr-reviewer`'s preOps use in production and the same fold
(`withInjectedContext`) every inline caller gets, budget statement included. That covers the
multi-file review cases the library was missing entirely, and the run-driver states the absent
checkout rather than letting the prompt claim one. Only the write side waits on container cells.

## Gotchas the first slice surfaced

- **`PROMPT_VERSIONS[id].text` is not the editable unit for a bespoke kind.** Reach for
  `shippedBasePromptFor`, and remember its inverse is `composedSystemPromptFor`, not
  `systemPromptFor`: the latter silently returns the thin `roles.ts` line for an inline ENGINE kind
  and then appends a second copy of directives the base already carried.
- **The code `reviewer` is a CONTAINER-backed companion** (`surface: 'container-explore'` in
  `COMPANIONS`), so `companionSystemPrompt` gives it the read-the-checkout paragraph. Any surface
  running it without one has to say so.
- **A bare word stem in `matchHints` matched nothing.** The scorer compares whole tokens, so
  `idempoten` was a dead hint that read as a reasonable fixture. Hints now take an explicit
  trailing `*` for prefix matching, and `registry.test.ts` caps hint length so an over-long phrase
  (which is effectively a demand for verbatim reproduction) fails too.
- **A fixture with no tricky expectation scores a constant `wowBonus` of 1**, so it ranks a thorough
  answer level with a shallow one. Two committed fixtures were in that state; the registry test now
  requires one high-impact and one tricky expectation each.
- **The catalog advertised the `coder` and then 400-ed every draft for it.** Splitting `bucket` from
  `sandboxRun` is what let the builder exclude it while its prompts stay editable.
- **Container cells will pick up the workspace prompt override unless told not to.** Their dispatch
  goes through `dispatchSystemPromptFor`, which reads `AgentRunContext.systemPromptOverride`; an
  experiment must run its SELECTED candidate, so that path needs the override suppressed
  EXPLICITLY. The symptom is not an error: every prompt column of the grid returns the same score.
- **A promotable kind whose JSON contract lives inside its ROLE text is one edit from silence.**
  The `task-estimator` takes its prompt from a built-in track, so a promoted candidate replaces the
  whole thing, contract included, and `coerceTaskEstimate` then parses nothing while the run looks
  normal. Its shape is now a named `OVERRIDE_PRESERVED_FRAGMENTS` member. **Check that before
  adding a kind to the catalog**: the bespoke `{ role, directives }` split is not available to a
  track-prompt kind.
- **A negatively-phrased expectation cannot be scored objectively.** `scoreExpectations` detects
  PRESENCE, so "does not invent a standard" scores "missed" against a model that behaved correctly
  and said nothing. State the positive behaviour a right answer contains, and leave the absence to
  the rubric dimension that covers it (the judge can see an absence; the token matcher cannot).

## Related

- [`@cat-factory/sandbox` AGENTS.md](../../backend/packages/sandbox/AGENTS.md) and
  [`@cat-factory/sandbox-fixtures` AGENTS.md](../../backend/packages/sandbox-fixtures/AGENTS.md)
- [`agent-prompt-overrides.md`](../../backend/docs/agent-prompt-overrides.md): the override the
  Sandbox composes a candidate as, and the promotion target
- [ADR 0053](../../backend/docs/adr/0053-unattended-run-autonomy.md): why the Requirement Writer's
  `confidence` is a rubric dimension of its own
