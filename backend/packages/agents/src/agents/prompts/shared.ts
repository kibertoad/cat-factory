// Shared constants used across the agent role prompts (standard solution phases,
// acceptance-testing track, business-logic track and the mock prompts). Kept here
// so the wording stays identical everywhere it is appended.

/**
 * The opening line of the folded best-practice-standards SECTION: it tells the agent to treat the
 * standards that follow as hard requirements rather than optional suggestions.
 *
 * Emitted by `foldStandards` (runtime/fragments.ts) as part of the section it introduces, NOT
 * appended to a role prompt. It used to be the hard-coded last line of every track prompt, while
 * the fold returns the base prompt UNCHANGED when the block resolved no standards — so on any
 * run without them the prompt ended by pointing at material that was never injected, and the
 * graders reported agents reviewing against, and reporting the absence of, a section they had been
 * told to expect. Owning the line where the blocks are written is what makes the pointer exist
 * exactly when its target does.
 *
 * A kind whose `standardsDelivery` is `context-files` is not folded and correctly gets no line
 * here: its standards index states the same thing about the files it lists. A kind delivered
 * `none` applies no standards at all, so there is nothing to be hard about.
 */
export const STANDARDS_SECTION_OPENER =
  'Follow these best-practice standards while doing the work: treat every standard below as a ' +
  'hard requirement, not a suggestion.'

/**
 * Appended to every agent whose deliverable IS its final reply (a document, report,
 * or JSON object the platform reads or parses) rather than a side effect like a
 * pushed commit. Some reasoning models emit their whole answer into the private
 * reasoning/thinking channel and leave the visible reply empty; the harness reads
 * only the visible content, so that empty reply fails the run (see
 * `unusableFinalAnswerCause`) even though the model "answered". This names the
 * channel so the answer lands where the platform reads it. Do NOT append this to
 * side-effect agents (the coder, ci-fixer, conflict-resolver, mocker): they
 * legitimately end with no final text, and telling them otherwise is wrong.
 */
export const FINAL_ANSWER_IN_REPLY =
  'Your deliverable is the text of your FINAL reply. Emit the complete answer as the ' +
  'visible content of that reply, NOT inside your private reasoning or thinking. A final ' +
  'reply whose visible content is empty is treated as a failure even when your reasoning ' +
  'contains the answer.'

/**
 * How a COMPANION reports what it found: one graded entry per point in `comments`, and a `summary`
 * that is a verdict rather than a second copy of the same list.
 *
 * This replaced a layout instruction that asked for the whole review as prose bullet groups
 * (`**Must fix**` / `**Should fix**` / `**Minor**`) inside the summary string. Those groups were
 * the right SHAPE and the wrong PLACE: they were the reviewer stating urgency in a channel only a
 * human reads, so a "must fix" and a nit reached the engine as the same thing and the run advanced
 * on the overall rating alone. Graded entries put the same judgement where the engine can act on
 * it (kernel's `disposeCompanionVerdict` holds the step while a `blocker` is open) and where the
 * panel can group and colour it, which prose never allowed.
 *
 * Each level therefore STATES what it costs, because the engine acts on all three and a reviewer
 * that cannot predict the consequence cannot grade deliberately. They are kept in step with
 * `disposeCompanionVerdict` by hand and in one direction: this text may describe less than the rule
 * does, never more.
 *
 * With the points structured, the summary must NOT restate them: the panel renders both, so a
 * duplicated review means writing everything twice in two orderings that can disagree. Same rule
 * the judge and the `pr-reviewer` have always followed ("do NOT restate the findings there").
 *
 * Two sentences here are load-bearing rather than editorial, both about `summary` being a JSON
 * STRING the platform parses. A raw line break inside one is invalid JSON (kernel's `extractJson`
 * repairs it, but a reviewer that escapes correctly never costs a repair retry), and a FENCED block
 * inside it puts a ``` pair ahead of the object in a reply whose JSON is not itself fenced, which is
 * what `extractJson` reads first. Inline backticks carry code in a verdict perfectly well.
 */
export const REVIEW_FINDINGS_LAYOUT =
  'REPORT EVERY POINT YOU RAISE AS ITS OWN `comments` ENTRY, GRADED BY URGENCY — never as prose ' +
  'buried in the summary. Each entry is {"severity":"blocker"|"major"|"minor","body":"…"}, plus ' +
  '"anchorId" when the thing you are commenting on is a structured item with an id (a spec ' +
  'requirement, an acceptance criterion). Grade every one of them:\n' +
  '- "blocker" — MUST be fixed before this work goes any further. Correctness, safety, data ' +
  'loss, a requirement not met, a claim the work does not support. While one of these is open ' +
  'the producer is sent back to fix it and the run does NOT advance, whatever you rate the work ' +
  'overall, so reserve it for what genuinely must not ship and never use it for a preference.\n' +
  '- "major" — should be fixed: a real gap or weakness a reviewer would ask about, but not one ' +
  'that makes the work unusable as it stands. On a FIRST review one of these buys the producer a ' +
  'revision pass even when you rate the work above its bar, so keep the level for a real gap.\n' +
  '- "minor" — a nit, polish or suggestion. Worth saying, never worth holding anything for: on its ' +
  'own it costs the producer no revision round and never stops the run.\n' +
  'Write each `body` as Markdown starting with a bolded short title, then one or two sentences ' +
  'saying what is wrong and the concrete change to make. Put code, paths, identifiers and ' +
  'commands in INLINE backticks. If the work is sound, return `comments` as an empty array ' +
  'rather than inventing something to say. ' +
  'THE SUMMARY IS A VERDICT, NOT A SECOND COPY OF THE LIST: two or three sentences on what the ' +
  'work is, what is genuinely good about it, and what holds it back overall. Do NOT restate the ' +
  'individual findings there. Both are rendered together, so anything written twice is read ' +
  'twice. Never open a fenced code block (```) inside the summary, and write any line break in ' +
  'it as a \\n escape and never as a raw line break inside the JSON.'

/**
 * Appended to every agent that reasons about a work item WITHOUT a checkout to orient itself in —
 * the inline reviewers and structured-dialogue agents (requirements review + rework, the Writer,
 * clarity triage, both brainstorm stages).
 *
 * Those agents receive a task's title and description and nothing else that names the software
 * under discussion, and a bare title ("implement webhooks") is domain-ambiguous. Asked for
 * concrete findings against it, a model will supply the missing product itself — and once one
 * pass has named a product, the incorporated document carries that invention into every later
 * pass. Naming the absent product is the finding; inventing one buries the real question under
 * confident detail about software that does not exist.
 *
 * Stated once here because it only holds if every agent in a flow honours it: a reviewer that
 * stays with the stated system, an editor that does not write an assumed one into the document,
 * and a Writer that does not recommend against one.
 */
export const NO_ASSUMED_PRODUCT =
  'THE SYSTEM UNDER DISCUSSION IS ONLY WHAT THE CONTEXT NAMES. Never assume, infer or introduce ' +
  'a product, company, vendor, framework, platform, tool or business domain the context you were ' +
  'given does not name — not to make a point concrete, and not as an illustrative example. If the ' +
  'context does not identify which system this work belongs to, treat that as a FACT ABOUT THE ' +
  'CONTEXT and not a gap in your knowledge: stay at the level the text actually supports, say ' +
  'plainly that the system is unidentified, and where a point genuinely depends on knowing which ' +
  'system this is, raise THAT as the point ("which service / product is this for?"). A confident ' +
  'answer about the wrong software is worse than an explicit "not stated here".'

/**
 * Appended to EVERY kind's system prompt by `systemPromptFor`, alongside the surface directives.
 *
 * The platform's own mechanics are visible to an agent from the inside — `cat-factory/<block>`
 * branch names, `.cat-context/` and `.cat-*` sentinel files, managed markers in a pull request
 * body — and a task with no product context of its own gives a model nothing else concrete to
 * anchor on. The platform name is then the most salient proper noun in the whole prompt, which is
 * how a neutral "implement webhooks" comes back as a design for the orchestrator's webhooks.
 *
 * Appended after any workspace override, so an edited prompt cannot delete it.
 */
export const PLATFORM_IS_NOT_THE_PRODUCT =
  'THE PLATFORM RUNNING YOU IS NOT THE PRODUCT YOU WORK ON. You are executed by an agent ' +
  'orchestration platform (cat-factory), and its mechanics are visible around you: branch names ' +
  'under `cat-factory/`, `.cat-context/` context files, `.cat-*` sentinel files, and managed ' +
  'markers in pull request bodies. Those belong to the harness running you. Never treat that ' +
  'platform, its name, its conventions or its features as part of the product, the domain or the ' +
  'requirements of the work you were given — and never let them stand in as the subject of a ' +
  'task that does not name a subject. They are in scope only when the work you were handed is ' +
  'itself about that platform.'

/**
 * Appended by the CONSENSUS executor to every participant's system prompt, because a panel runs
 * its participants as plain inline model calls — no filesystem, no shell, no subagents.
 *
 * Most consensus-eligible kinds (`architect`, `analysis`, `reviewer`, `doc-reviewer`,
 * `pr-reviewer`) are container kinds whose shipped prompt is written for a real checkout: it tells
 * them to run `git diff`, read `.cat-context/*` files and dispatch slice subagents. Run inline
 * that prompt describes a machine the participant is not on, and a model handed instructions it
 * cannot follow does not stop — it narrates the steps it would have taken, or quietly reviews
 * from filenames. This states the actual surface so the participant works from what it was given.
 *
 * It does NOT restate what the participant HAS: everything the engine prepared is folded into the
 * user prompt by `userPromptFor`, which is the message this directive points at.
 */
export const INLINE_PANEL_SURFACE =
  'SURFACE FOR THIS RUN: you are one participant in a multi-model panel and you are running as a ' +
  'single inline model call. You have NO checkout, NO shell, NO git and NO subagents, so ignore ' +
  'any instruction above to run a command, read a file from disk or a `.cat-context/` path, or ' +
  'dispatch parallel reviewers — none of that is available to you. Everything prepared for this ' +
  'run has been inlined into the message you were given; that message is your ONLY source. Do not ' +
  'describe the steps you would have taken, and never treat a file you were not shown as ' +
  'reviewed — if part of the work was not included, judge what you were given and say plainly ' +
  'which part you could not see.'

/**
 * The sentinel file every CONTAINER agent writes its effort self-assessment to. Kept in sync
 * with the harness's own constant (executor-harness has no dependency on this package), exactly
 * like `CONTEXT_DIR` / {@link FOLLOW_UPS_FILE}. The harness reads + removes it after the run and
 * keeps it out of any commit.
 */
export const EFFORT_REPORT_FILE = '.cat-effort.json'

/**
 * The sentinel file a follow-up-companion coding agent APPENDS its forward-looking items to, one
 * JSON object per line, in its working directory. Kept in sync with the harness's own constant
 * (executor-harness has no dependency on this package), exactly like {@link EFFORT_REPORT_FILE}.
 * The harness tails it live and keeps it out of any commit.
 */
export const FOLLOW_UPS_FILE = '.cat-follow-ups.jsonl'

/**
 * Appended to EVERY container-agent system prompt (at the container-dispatch chokepoint, see
 * `buildKindBody`). It asks the agent to end its work by writing a short, honest self-assessment
 * of the effort to a sentinel file — how hard/easy the work was, what reduced its effectiveness,
 * and the key obstacles it hit — which the harness lifts onto the result and the platform surfaces
 * in run details. This is a SIDE channel: it is kept out of the commit/PR, so writing it never
 * affects the deliverable, and the agent still completes its actual task regardless.
 *
 * BOTH halves of the write/no-write reconciliation live HERE, because this is the only text that
 * reaches every container kind. The chokepoint appends it to the read-only kinds, whose guardrail
 * forbids creating files, and to the bespoke `merger` / `on-call` prompts, which short-circuit
 * `systemPromptFor` entirely (see `composedSystemPromptFor`) and so can never receive a carve-out
 * written into that guardrail. An agent handed the contradictory pair either disobeys one of them
 * or spends a turn asking which wins, which is what the graders kept filing.
 *
 * The timing clause is scoped to what the AGENT did ("any commit or push you made") rather than
 * asserting what the STEP does. A read-only step can still commit: the `spike` kind's findings are
 * committed and published by a backend post-op the agent takes no part in.
 */
export const EFFORT_REPORT_GUIDANCE =
  'EFFORT SELF-ASSESSMENT — as the last thing you do, once your work is complete (including any ' +
  'commit or push you made), write a ' +
  `file named \`${EFFORT_REPORT_FILE}\` in your working directory containing a SINGLE compact ` +
  'JSON object: {"difficulty":<1-10>,"summary":"<one or two sentences on how hard or easy this ' +
  'was and why>","reducedEffectiveness":"<what, if anything, reduced your effectiveness — ' +
  'unclear requirements, flaky tooling, missing context, etc.>","obstacles":["<each key ' +
  'obstacle you hit>"]}. `difficulty` is 1 (trivial) to 10 (extremely hard). Be honest and ' +
  'specific — this is feedback for the humans running you, not part of the deliverable. Writing ' +
  'this one file is expected even where your instructions forbid you to create, modify or commit ' +
  'files: it is the single exception those instructions permit, because the harness keeps it out ' +
  'of every commit, so writing it changes nothing in the repository. It is a side channel only: ' +
  'never reference it in code and never add it to git. Write it exactly once, at the end.'

/**
 * Appended to EVERY container-agent system prompt at the same chokepoint as
 * {@link EFFORT_REPORT_GUIDANCE} (`buildKindBody`): what the execution environment can and cannot
 * do.
 *
 * These are PLATFORM facts no agent can derive from the repository, and the graders kept catching
 * the same waste with them absent. A coder and its reviewer independently discovered that the
 * Dockerfile they were asked for could not be built here, then spent two consecutive rounds on the
 * wording of that disclosure; separately, a Node 26 sandbox against a Node 22 target produced an
 * `EBADENGINE` warning the reviewer filed as a defect in the change. None of that is resolvable by
 * the agent, and all of it is one paragraph of context.
 *
 * EVERY tool is stated as a PROBE rather than as a presence or an absence, and the environment
 * itself is never named, because the honest answer varies by runtime and this text is composed
 * BEFORE the transport is chosen. The usual case is the harness image (a rootless Docker daemon
 * `entrypoint.sh` starts BEST-EFFORT, which Cloudflare Containers and most managed runners forbid,
 * while a self-hosted pool may point `DOCKER_HOST` at a sidecar instead). But the same job body
 * also serves the local NATIVE transport (`LOCAL_NATIVE_AGENTS`), which runs the developer's own
 * CLI as a process on their machine, where `kubectl` may well be installed, Docker Desktop may be
 * running and the toolchain is theirs. So "an ephemeral Linux container", "no Kubernetes tooling"
 * and "a Docker CLI IS installed" are each false on one of those two paths, while "check, and do
 * not read a failure as your bug" is true on both. Toolchain VERSIONS take the same shape for a
 * second reason as well: naming the image's Node major here would duplicate the Dockerfile's pin
 * into a constant nothing keeps in step with it.
 *
 * The closing rule is the part that pays for the paragraph, and it stops one step short of the
 * claim it would be convenient to make: unverifiable is not the same as correct. An artifact this
 * environment cannot execute is not INCOMPLETE for that reason, and the limit itself is not a
 * finding, but a defect a reviewer can actually see in the artifact still is one. The paragraph
 * reaches the reviewer companions too, so "still a complete and correct deliverable" would be the
 * platform telling every reviewer to pass a Dockerfile with a real syntax error in it, on the
 * grounds that it could not be built here.
 *
 * Unconditional, for every container kind rather than only those whose deliverable can BE an
 * executable artifact: a reviewer reviews such artifacts, and any kind can be asked to probe for a
 * tool. Gating it per kind would reintroduce the rediscovery it exists to prevent, one
 * misclassification at a time, so the paragraph is kept short instead and names no tooling except
 * as a probe example.
 */
export const EXECUTION_SANDBOX_GUIDANCE =
  'EXECUTION SANDBOX — you run in a disposable working environment the platform provisions for ' +
  'this step: a fresh clone of the repository, git and a Node toolchain. Treat nothing else as ' +
  'guaranteed: probe for a tool (`docker info`, `kubectl version`, a language runtime) before ' +
  'relying on it, and never report a missing tool or a failed probe as a defect in the work. The ' +
  'platform hands you no cluster or container-registry credentials, so applying a manifest, ' +
  'reaching a cluster and pulling or pushing an image are out of scope for this step unless this ' +
  "run handed you a credential for them. Toolchain versions here are the ENVIRONMENT's, not " +
  "necessarily your target's — compare `node --version` against the project's declared engines " +
  'before concluding that a version warning or failure is a bug in the code. Above all: a ' +
  'deliverable this environment cannot EXECUTE (a Dockerfile you cannot build, a manifest you ' +
  'cannot apply, a deploy you cannot run) is not incomplete or incorrect for that reason. Produce ' +
  'it, then name in ONE line of your report which artifacts you could not verify here and why. Do ' +
  'not hedge the artifact, do not spend turns rediscovering the limit, and do not raise the limit ' +
  'itself as a finding against the work or another agent: a defect you can actually see in the ' +
  'artifact still is one.'

/**
 * The directives the container-dispatch chokepoint appends to EVERY container job, in the order it
 * appends them: what the environment can and cannot do, then the effort self-assessment.
 *
 * Declared here rather than inlined at the chokepoint because two callers have to agree on the
 * exact text. The dispatch (`buildKindBody`) SENDS it, and `appendedDirectivesFor` MEASURES what a
 * workspace's override cannot delete, so the prompt editor can show it rather than describe it in
 * prose that drifts. With the pair inlined in `@cat-factory/server` the measurement could not see
 * it and the editor promised a shorter contract than the wire carried.
 *
 * Only the UNCONDITIONAL pair belongs here. The chokepoint also appends per-STEP text (the
 * follow-up companion, bug-fix guidance, a skill directive, the wired tool servers), which depends
 * on the run rather than on the kind and so cannot be measured for a kind at all.
 */
export const CONTAINER_DISPATCH_DIRECTIVES = [
  EXECUTION_SANDBOX_GUIDANCE,
  EFFORT_REPORT_GUIDANCE,
] as const

/** Append {@link CONTAINER_DISPATCH_DIRECTIVES} to `prompt`, in the order a dispatch sends them. */
export function appendContainerDispatchDirectives(prompt: string): string {
  return [prompt, ...CONTAINER_DISPATCH_DIRECTIVES].join('\n\n')
}

/**
 * The sentinel file a PR-opening coding agent writes its pull-request description to, at the root
 * of the checkout the PR belongs to. Kept in sync with the harness's own constant (executor-harness
 * has no dependency on this package), exactly like `EFFORT_REPORT_FILE` above.
 */
export const PR_DESCRIPTION_FILE = '.cat-pr-description.md'

/**
 * Appended to a coding kind's system prompt ONLY when its dispatch opens a pull request (see
 * `buildCodingAgentBody`). It asks the agent to end its work by writing the reviewer-facing PR
 * description — a briefing carrying what the diff cannot show (problem, decisions, watch-outs),
 * never a restated diff — to a sentinel file the harness lifts onto the PR it opens. Without it
 * the PR falls back to the generic dispatch-time text (`prBody`), which is composed BEFORE the
 * agent runs and so can never describe the decisions actually made. This is a SIDE channel: the
 * platform keeps the file out of the commit, so writing it never affects the deliverable.
 */
export const PR_DESCRIPTION_GUIDANCE =
  'PULL REQUEST DESCRIPTION — when you have finished the work, write the reviewer-facing pull ' +
  `request description to a file named \`${PR_DESCRIPTION_FILE}\` at the top level of the ` +
  'repository checkout (in a multi-repo workspace: one file at the root of EACH sibling ' +
  "repository you changed, each describing that repository's own pull request). The platform " +
  'opens the pull request for you and uses this file as its description; if you skip it, a ' +
  'generic auto-generated description is used instead. You may start the file with a single ' +
  '`# <title>` heading line to set the pull request title (imperative mood, under 70 ' +
  'characters). Write the rest as a briefing for a human reviewer, in markdown, covering what ' +
  'the diff cannot show: the problem being solved and the intent of the change; the key ' +
  'decisions you made along the way, especially where you considered an alternative and ' +
  'rejected it (say what and why); and what the reviewer should be aware of or look out for — ' +
  'behaviour changes, the riskiest or least-obvious part of the change, anything that only ' +
  'makes sense with context the diff does not carry. Do NOT restate what the diff already ' +
  'shows: no file lists, no per-change narration, no test tallies. Never include secrets, ' +
  'tokens, or credentials. Do not reference issues or pull requests by number (`#123`, `!123`), ' +
  'mention accounts (`@name`), or put issue-closing wording such as "fixes" or "closes" in front ' +
  'of an issue link: the platform defuses all of those before publishing, so they would render ' +
  'as inert text rather than doing what you intended. This file is a side channel: it is kept ' +
  'out of the commit, so never reference it in code and never add it to git. Write it once, at ' +
  'the end of your work.'

/**
 * Appended to a code/PR review agent's system prompt. It asks the reviewer to report, per
 * best-practice standard, how well the reviewed object adheres — a 1..10 rating plus the specific
 * issues that standard surfaced — as a `fragmentAdherence` array in its JSON output. The standards
 * are labelled per-standard precisely so this can be per-standard. If NO best-practice standards
 * were provided, the reviewer must say so rather than invent ratings.
 *
 * The standards reach the reviewer one of two ways (see {@link AgentKindDefinition.standardsDelivery}),
 * so the "where are the standards" sentence differs:
 *  - {@link FRAGMENT_ADHERENCE_GUIDANCE} — folded into THIS prompt as `<best-practice-standard>`
 *    blocks (the default, for a kind that does the review itself in one context).
 *  - {@link FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES} — delivered as `.cat-context/standard-*.md`
 *    files (for a kind that DELEGATES the review to per-slice subagents; folding the standards into
 *    the delegating prompt charges it for every standard on every turn while the subagents that
 *    apply them never receive them — the pr-reviewer case). The rating still comes from the real
 *    standard text, just read from the file rather than the prompt.
 *
 * The prompt-folded variant says ANY rather than THE, asks whether a block APPEARS rather than
 * describing an empty array, and claims no POSITION for the blocks, for the same reason
 * {@link STANDARDS_SECTION_OPENER} moved into the fold: the fold writes nothing when a block
 * resolved no standards, so an opening that asserted the blocks were there was the second half of
 * the same dangling pointer the graders quoted (they reported a reviewer instructed to review
 * against blocks 'folded into this prompt above' when none were injected). It cannot move into the
 * fold as the opener did, being a JSON output contract rather than a standards header, so it is
 * worded to be true in all three delivery states instead.
 *
 * The POSITION is the half that survived the first pass at this, and it was still wrong:
 * `foldStandards` appends the blocks BELOW the base prompt that carries this guidance, so a
 * reviewer applying "if no such block appears above" to the text above it finds none and reports an
 * absence on a run where the standards were folded in. Nothing in the composition can promise a
 * direction, so the guidance names none.
 *
 * The `_CONTEXT_FILES` variant states its channel as the NORMAL one rather than the only one,
 * because the fold is not suppressed unconditionally for a `context-files` kind: when the preOp
 * that writes the files did not run, {@link composeBlockSystemPrompt} folds the standards into the
 * prompt rather than losing them through both channels. "NOT in this prompt" was false in exactly
 * that fallback, and the fallback is also where this text tells the reviewer to report that no
 * standards were available.
 */
const FRAGMENT_ADHERENCE_REPORT_SHAPE =
  'In your JSON output include a `fragmentAdherence` array with ONE entry per standard you ' +
  'used, of shape {"title":"<the standard\'s title>","fragmentId":"<its id>","rating":<1-10>,' +
  '"assessment":"<how well the reviewed change adheres to this standard and why>",' +
  '"relatedFindings":["<short reference to each issue this standard surfaced>"]}. `rating` is 1 ' +
  '(the change flatly violates the standard) to 10 (it fully adheres). Refer to each standard by ' +
  'its TITLE.'

export const FRAGMENT_ADHERENCE_GUIDANCE =
  'BEST-PRACTICE ADHERENCE — ANY best-practice standards you must review against are folded ' +
  'into this prompt as separate `<best-practice-standard>` blocks, each with a stable id and a ' +
  'title. ' +
  FRAGMENT_ADHERENCE_REPORT_SHAPE +
  ' If no such block appears anywhere in this prompt, none were provided for this review: ' +
  'return `fragmentAdherence` as an empty array AND state explicitly in your summary that no ' +
  'best-practice standards were available to review against — do not invent any.'

export const FRAGMENT_ADHERENCE_GUIDANCE_CONTEXT_FILES =
  'BEST-PRACTICE ADHERENCE — the best-practice standards you must review against normally reach ' +
  'you as files rather than as prompt text: the `.cat-context/standard-<id>.md` files listed in ' +
  '`.cat-context/standards.md`. Each `fragmentAdherence` rating MUST come from the real standard ' +
  "text (yours or a slice subagent's read of the file), never a paraphrase. " +
  FRAGMENT_ADHERENCE_REPORT_SHAPE +
  ' If this run folded them into this prompt instead, as `<best-practice-standard>` blocks, review ' +
  'against those. If NEITHER channel carries any, return `fragmentAdherence` as an empty array AND ' +
  'state explicitly in your summary that no best-practice standards were available to review ' +
  'against — do not invent any.'

/**
 * Appended to the Coder's system prompt ONLY when the Follow-up companion is enabled for
 * the step. It tells the Coder to be future-looking: as it works, append one JSON line per
 * forward-looking item to the {@link FOLLOW_UPS_FILE} sentinel file in its working
 * directory: either a `follow_up` (a genuine loose end / useful side-task it noticed but
 * is deliberately NOT acting on in this pass) or a `question` (a clarification it would
 * otherwise have to guess at). The harness streams these out live so a human can triage
 * them while the Coder still runs. The file is NOT part of the deliverable (the platform
 * keeps it out of the commit/PR), so writing to it never affects the implementation. This
 * is a SIDE channel: the Coder still finishes its actual task; it does not wait for
 * answers (an answer arrives later as a fresh task if the human sends one back).
 */
export const FOLLOW_UP_GUIDANCE =
  'FORWARD-LOOKING FOLLOW-UPS — be future-looking as you work. Whenever you notice a ' +
  'genuine loose end, useful follow-up or side-task you are NOT acting on in this pass, ' +
  'or a clarifying QUESTION you would otherwise have to guess at, record it by APPENDING ' +
  `one JSON object per line to a file named \`${FOLLOW_UPS_FILE}\` in your working ` +
  'directory (create it if absent; never overwrite it). Each line must be a single ' +
  'compact JSON object: {"kind":"follow_up"|"question","title":"<short headline>",' +
  '"detail":"<full explanation>","suggestedAction":"<optional concrete next step>"}. ' +
  'Use "follow_up" for loose ends / side-tasks and "question" for a clarification. Do NOT ' +
  'act on the follow-ups yourself in this pass, and do NOT block waiting for answers to ' +
  'questions — keep delivering the task. This file is a side channel only; it is kept out ' +
  'of the commit, so never reference it in code and never add it to git.'
