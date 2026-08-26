# Initiative: Agent-run environment fidelity

Tracker for four related defects, all found in one real run
(`exec_11d0032fda3e4b74902adc92`, pipeline `pl_build`, harness `claude-code`,
backend `local-container`). Each is a place where the platform's model of what a
containerised agent is doing has drifted from what it actually does, and every one
of them costs a run rather than degrading it.

## Goal & rationale

A container agent is judged, bounded and equipped by a harness that cannot see
inside it. That is fine while the harness's proxies for "working", "equipped" and
"finished" hold. They have stopped holding, in four separate ways:

- the progress bound reads TOOL NAMES, so an agent working entirely through `bash`
  reads as doing nothing;
- an aborted run's uncommitted work is discarded rather than recovered;
- the tool surface and the image the agent is handed no longer match what it needs;
- the prompt describes a sandbox the agent is not actually in.

End state: every bound the harness enforces is evidence-based, no abort silently
destroys work, and what the agent is TOLD about its environment matches what it
HAS. Each slice bumps the runner image, so the tracker records which tag carried
which fix.

## Evidence

One local run, 2026-08-26 12:02:19 to 12:17:46 UTC, task "Stand up the catalog API
service". In 15 minutes the coder wrote a `package.json`, a `tsconfig.json`, an
application, two test files, a `Dockerfile`, k8s manifests, a manifest-contract
checker, an eslint config, two GitHub workflows and a README; reached
`LINT OK / TYPECHECK OK / BUILD OK` with 25 tests passing; booted the compiled
server and byte-compared three endpoints against its own README. Every one of its
40 tool calls succeeded. The progress guard then killed it for "40 tool calls and
not one file edit", and because the agent had never run `git commit`, the settle
path (which commits edits to already-tracked files only) had nothing to save. All
of it was lost.

Across four runs of this task on 08-24 to 08-26 the coder used `Write` zero times.
Four runs of the identical task on 08-12 and 08-13 used it 26 to 34 times per
dispatch. The proxy did not break; the model's habits moved.

## Slices

| #   | Slice                                                       | Issue                                                         | PR      | Image tag |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------- | ------- | --------- |
| 1   | Evidence-based progress bound + salvage of uncommitted work | [#2096](https://github.com/kibertoad/cat-factory/issues/2096) | this PR | `1.133.0` |
| 2   | Tool surface (`--tools`)                                    | [#2097](https://github.com/kibertoad/cat-factory/issues/2097) |         |           |
| 3   | Runner image (docker daemon, `NODE_ENV`, missing binaries)  | [#2098](https://github.com/kibertoad/cat-factory/issues/2098) |         |           |
| 4   | Sandbox inventory and prompt fixes                          | [#2099](https://github.com/kibertoad/cat-factory/issues/2099) |         |           |

Landing order is the table order: slice 1 first because it is the one losing work.

## Decisions

### D1: The no-edit bound decides on the WORKING TREE, not on tool names

**Decision: `ProgressGuard` returns a discriminated verdict. Every streak bound
(consecutive errors / web calls / MCP calls / non-action calls) stays `abort`, settled
from the stream alone. The no-edit bound answers `needs-workspace-evidence`, and the
caller probes `git status --porcelain --untracked-files=all` plus `HEAD` before
anything is killed.**

The bound has always been asking "has this run changed the repository". Tool names
were a cheap sufficient condition for that, never a necessary one, and the note at
the definition site said so from the start: "a file written purely via `bash` is not
recognised here — broaden or move to a working-tree signal if that becomes common."
It became common.

Broadening the tool-name set was evaluated and rejected. It cannot work: `bash` is
already the one tool the bound exists to catch, so counting it as an edit would
disarm the guard entirely, and no subset of `bash` invocations is recognisable from
the call name. The working tree is the only signal that is both correct and immune
to which tool the model picks.

### D2: The probe runs at the abort, not on the hot path

**Decision: at most one probe per run. A positive probe satisfies the bound
PERMANENTLY (`noteWorkspaceMutation`), exactly as a recognised edit-tool call does.
A negative probe aborts. Neither can repeat.**

The bound only ever matters at the instant it is about to abort, so that is the only
instant worth spending a `git status` on. The permanence is not an optimisation: it
matches the bound's existing semantics, which guard a run only UNTIL its first edit,
because an agent that has changed the tree has demonstrably started the work.

Both call sites are synchronous stream handlers (`pi.ts`'s JSONL reader,
`agent-runner.ts`'s `tool_use`/`tool_result` pairing) and neither can await inside
one, so `guard-driver.ts` owns the probe's lifetime instead. The guard itself stays
pure and synchronous, which is what lets `harness.test.ts` keep driving it over a
fixed event sequence, and the probe is INJECTED rather than imported.

### D3: A probe that throws is inconclusive, and fails OPEN

**Decision: on a probe error, re-arm the bound (it can trip again after another
`maxToolCallsWithoutEdit` action calls) and warn with the cause. Never abort.**

The two errors are not symmetric. Killing a productive run costs the whole run;
letting an unproductive one continue costs some tokens, and the streak bounds, the
inactivity watchdog and the wall-clock cap all still hold it. A `git` failure is
also exactly the kind of transient the run should not die of.

### D4: Salvage is real, marked, bounded, and all-or-nothing

**Decision: the settle path commits the new untracked non-ignored files the agent
left behind, and an aborted run salvages them and pushes before it reports its
failure. Over the file-count or byte bound, salvage NOTHING and say so.**

`commitTrackedEdits` captures edits to files git already tracks, so a new file was
found, warned about and dropped. On a greenfield task every file is new, which made
that warning the whole deliverable going in the bin. Observable is not recovered.

A partial salvage is worse than none: a half-committed tree reads as a complete
change, and the run that produced it is not around to say otherwise. So the bound is
a refusal, not a truncation, and the refusal is reported.

The deny-list (`node_modules`, `dist`, `build`, `coverage`, `.venv`, `__pycache__`,
`target`, `vendor`, `*.log`, plus the harness's own sentinels) exists because a
greenfield checkout may have no `.gitignore` yet: the agent had not written one when
it was killed, and git only excludes what it is told to. It is deliberately short.
A `dist/` that genuinely belonged in a commit is a far cheaper miss than a
`node_modules/` that did not.

The commit message states its own provenance. A commit arriving on a branch with no
explanation is indistinguishable from work the agent chose to make and someone chose
to keep, and this work was chosen by nobody: the run was killed with it on the floor.

Coding modes only, enforced structurally: `salvage.ts` is importable only from
`coding-agent.ts` and `multi-repo-coding.ts`, and a test asserts that set. A
read-only kind has no work branch to carry a commit and must never be given one.

### D5: The diagnostic states the evidence it acted on

**Decision: a guard abort after a negative probe quotes the sha and says the tree was
clean. The generic `agent` failure hint stops claiming retries it cannot know about.**

The run above reported "An agent step failed after its automatic retries" while
`detail.steps[2].attempts` was `1`. The hint now points at the step's own attempt
count and failure detail rather than asserting a history.

## Gotchas the first slice surfaced

- **The baseline is the PASS, not the clone.** A repair round is a fresh agent that
  must show its OWN progress; baselining against the clone would let the previous
  round's commits satisfy a bound the current round never earned.
- **Sentinels match by basename.** In a monorepo the agent's cwd is a service
  subdirectory, so its effort report lands at `services/api/.cat-effort.json`. A
  root-anchored exclusion misses it, and a run that wrote nothing but its own effort
  report then reads as productive.
- **Salvage must run BEFORE the no-op judgement.** `branchHasCommitsSince` decides
  whether the branch is pushed at all, so a leg whose only work is salvaged files is
  read as untouched if the salvage lands after it.
- **A scaffold-from-scratch checkout has no `HEAD`.** `rev-parse` errors there, which
  is not a reason to leave the bound blind: the dirty-tree half is exactly what
  answers a from-scratch build, so the pass baselines against the empty sha.
