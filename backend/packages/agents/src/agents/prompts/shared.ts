// Shared constants used across the agent role prompts (standard solution phases,
// acceptance-testing track, business-logic track and the mock prompts). Kept here
// so the wording stays identical everywhere it is appended.

/**
 * Closing line every role prompt appends before `composeSystemPrompt` folds in
 * the user's selected best-practice fragments — it tells the agent to treat those
 * appended standards as hard requirements rather than optional suggestions.
 */
export const STANDARDS_FOOTER =
  'Treat every best-practice standard appended below as a hard requirement, not a suggestion.'

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
 * Appended to the Coder's system prompt ONLY when the Follow-up companion is enabled for
 * the step. It tells the Coder to be future-looking: as it works, append one JSON line per
 * forward-looking item to the `.cat-follow-ups.jsonl` sentinel file in its working
 * directory — either a `follow_up` (a genuine loose end / useful side-task it noticed but
 * is deliberately NOT acting on in this pass) or a `question` (a clarification it would
 * otherwise have to guess at). The harness streams these out live so a human can triage
 * them while the Coder still runs. The file is NOT part of the deliverable (the platform
 * keeps it out of the commit/PR), so writing to it never affects the implementation. This
 * is a SIDE channel — the Coder still finishes its actual task; it does not wait for
 * answers (an answer arrives later as a fresh task if the human sends one back).
 */
/**
 * The sentinel file every CONTAINER agent writes its effort self-assessment to. Kept in sync
 * with the harness's own constant (executor-harness has no dependency on this package), exactly
 * like `CONTEXT_DIR` / the follow-ups sentinel. The harness reads + removes it after the run and
 * keeps it out of any commit.
 */
export const EFFORT_REPORT_FILE = '.cat-effort.json'

/**
 * Appended to EVERY container-agent system prompt (at the container-dispatch chokepoint, see
 * `buildKindBody`). It asks the agent to end its work by writing a short, honest self-assessment
 * of the effort to a sentinel file — how hard/easy the work was, what reduced its effectiveness,
 * and the key obstacles it hit — which the harness lifts onto the result and the platform surfaces
 * in run details. This is a SIDE channel: it is kept out of the commit/PR, so writing it never
 * affects the deliverable, and the agent still completes its actual task regardless.
 */
export const EFFORT_REPORT_GUIDANCE =
  'EFFORT SELF-ASSESSMENT — when you have finished your work (after any commit/push), write a ' +
  `file named \`${EFFORT_REPORT_FILE}\` in your working directory containing a SINGLE compact ` +
  'JSON object: {"difficulty":<1-10>,"summary":"<one or two sentences on how hard or easy this ' +
  'was and why>","reducedEffectiveness":"<what, if anything, reduced your effectiveness — ' +
  'unclear requirements, flaky tooling, missing context, etc.>","obstacles":["<each key ' +
  'obstacle you hit>"]}. `difficulty` is 1 (trivial) to 10 (extremely hard). Be honest and ' +
  'specific — this is feedback for the humans running you, not part of the deliverable. It is a ' +
  'side channel only: it is kept out of the commit, so never reference it in code and never add ' +
  'it to git. Write it exactly once, at the end.'

/**
 * Appended to a code/PR review agent's system prompt. It asks the reviewer to report, per
 * best-practice standard folded into its prompt (the delimited `<best-practice-standard>` blocks),
 * how well the reviewed object adheres — a 1..10 rating plus the specific issues that standard
 * surfaced — as a `fragmentAdherence` array in its JSON output. The standards are fed as separate
 * labelled blocks precisely so this can be per-standard. If NO best-practice standards were folded
 * in (none selected / the library isn't configured), the reviewer must say so rather than invent
 * ratings.
 */
export const FRAGMENT_ADHERENCE_GUIDANCE =
  'BEST-PRACTICE ADHERENCE — the best-practice standards you must review against are folded into ' +
  'this prompt above as separate `<best-practice-standard>` blocks, each with a stable id and a ' +
  'title. In your JSON output include a `fragmentAdherence` array with ONE entry per standard you ' +
  'used, of shape {"title":"<the standard\'s title>","fragmentId":"<its id>","rating":<1-10>,' +
  '"assessment":"<how well the reviewed change adheres to this standard and why>",' +
  '"relatedFindings":["<short reference to each issue this standard surfaced>"]}. `rating` is 1 ' +
  '(the change flatly violates the standard) to 10 (it fully adheres). Refer to each standard by ' +
  'its TITLE. If NO best-practice standards were provided (the array of blocks above is empty), ' +
  'return `fragmentAdherence` as an empty array AND state explicitly in your summary that no ' +
  'best-practice standards were available to review against — do not invent any.'

export const FOLLOW_UP_GUIDANCE =
  'FORWARD-LOOKING FOLLOW-UPS — be future-looking as you work. Whenever you notice a ' +
  'genuine loose end, useful follow-up or side-task you are NOT acting on in this pass, ' +
  'or a clarifying QUESTION you would otherwise have to guess at, record it by APPENDING ' +
  'one JSON object per line to a file named `.cat-follow-ups.jsonl` in your working ' +
  'directory (create it if absent; never overwrite it). Each line must be a single ' +
  'compact JSON object: {"kind":"follow_up"|"question","title":"<short headline>",' +
  '"detail":"<full explanation>","suggestedAction":"<optional concrete next step>"}. ' +
  'Use "follow_up" for loose ends / side-tasks and "question" for a clarification. Do NOT ' +
  'act on the follow-ups yourself in this pass, and do NOT block waiting for answers to ' +
  'questions — keep delivering the task. This file is a side channel only; it is kept out ' +
  'of the commit, so never reference it in code and never add it to git.'
