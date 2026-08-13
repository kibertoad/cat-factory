---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/agents': minor
'@cat-factory/local-server': patch
---

Let a binary-output step generate through the agent CLI's own tool, with no vendor API key.

`BinaryGeneratorDefinition` gains a `transport` discriminator. `api` is the existing shape (a
metered endpoint the agent's own code calls with an injected credential) and stays the default, so
every registered integration is unchanged. `harness` is new: the artifact is produced by a tool
built into the agent CLI the step dispatches under, which today means Codex's `image_gen` — a path
available ONLY on ChatGPT subscription auth, since an `OPENAI_API_KEY` session is routed to the
Images API and never offered the tool. A harness-transport definition may declare no `endpoint`,
`credentials` or `contracts`; the credential rule is the one that matters, because a declared one
would be an environment variable the deployment believes authenticates something and that nothing
ever reads.

Boot validation holds a harness transport to a CLI that actually generates, which today is codex
alone. "This build runs that CLI" and "that CLI has a generation tool" are different questions, and
admitting the first lets a definition naming `pi` or `claude-code` pass every check, dispatch with
the tool flag set, produce nothing, and brief the agent to collect from a directory nothing created.

Reachability becomes its own admission axis (`generator_harness_unavailable`): a step selecting a
harness-served integration must resolve to that CLI. The requirement is DERIVED from the step's
model by the same precedence dispatch uses — including the fall-through past an unresolvable block
pin and the "subscriptions always win" override, without which the guard refuses a codex-served
generator on a step that is about to run codex. An unresolved model raises nothing. Notably this is
NOT a capability flag on the model catalog: whether the tool is offered is decided by the vendor per
session and per plan tier, so a boolean on a model row would be a guarantee nothing here can verify.
The pipeline builder states the constraint it cannot check (which CLI serves each candidate, and
which the current selection needs) as advice, since a pipeline is a template and the model is chosen
per task.

The harness redirects codex's output into `.cat-context/binary-output/generated/` before the CLI
starts, because codex exposes no path for what it generated and its output directory is also where
the run's decrypted subscription credential lives. It is opt-in per job: the tool bills the leased
plan at several times an ordinary turn. `generateImages` joins the job-body capability handshake, so
a runner pool on an older image is refused rather than run blind against a brief that names the
staging directory regardless. Where the capability genuinely cannot be honoured (an `ambientAuth`
run has no per-run home to redirect, a filesystem refuses the link) the harness says so in the
prompt instead of dropping it, and the teardown report tells a late-arriving image apart from one
that was never reachable.

Separately, the harness now consumes the job body's `artifactUpload` and surfaces it as
`ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN`. The backend has injected that field and served the
ingest route since the visual-confirmation work while the container parsed neither, so a UI run's
screenshots were dropped with no error anywhere.
