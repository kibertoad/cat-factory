// The job-body CAPABILITY HANDSHAKE: which optional body fields a running harness image
// actually parses, and what a dispatch may conclude when the answer does not cover what it sent.
//
// Why this exists at all. The job body grows optional fields, and an image that predates one
// does not fail on it: `parseAgentJob` reads the fields it knows and ignores the rest. For most
// fields that degrades honestly (nothing was promised, nothing arrives). For a CAPABILITY it does
// the opposite: the backend composes the prompt, so a dropped `mcpServers` leaves the agent
// reading "you have these tools, prefer them over guessing" with no client wired. That is a BLIND
// run rather than a failed one, and until now the backend had no signal at all about what image a
// self-hosted runner pool pins (the executor-harness CHANGELOG says exactly this, twice).
//
// The handshake closes it: the harness reports the capability names it parses, the dispatch
// compares that against what it put in the body, and the answer is THREE-STATE rather than a
// boolean. An image that reports nothing is not the same fact as an image that reports a list
// without the capability in it: the first predates the handshake and may well serve the
// capability perfectly, while the second has said it cannot. Folding them would refuse every
// run on every image older than this one, which is a false accusation, not a safety margin.

import type { RunnerDispatchAck, RunnerJobStopOutcome } from '../ports/runner-transport.js'

/**
 * The optional job-body fields that are CAPABILITIES: a promise the prompt makes on the body's
 * behalf, so a silent drop leaves the agent misinformed rather than merely unequipped.
 *
 * Deliberately NOT "every optional body field". A field whose absence the agent cannot notice
 * (`packageRegistries`, `validation`) needs no handshake, because an older image simply does less and
 * the run reports what it did. Adding a member here is a claim that the PROMPT would lie.
 *
 * That is also why `designImages` is a member and `referenceScreenshots` is not, though they are the
 * same wire shape: the capture block is composed BY the harness out of what actually landed, so an
 * image that ignores the field simply says nothing, while the design block is composed by the
 * BACKEND (only it knows the delivery verdict and the views no container was sent) and would name a
 * directory an older image never wrote.
 *
 * `generateImages` is a member for exactly that reason and not for its own shape: it is a bare
 * flag, but the generator brief it turns on names a staging directory unconditionally, so an image
 * that ignores the flag leaves the agent hunting for output in a directory nothing created, and the
 * run reports a vendor problem for what is a runner pool one release behind. `artifactUpload` is
 * NOT a member for the opposite reason: it is delivered as environment variables the prompt names
 * only where they are read, and an image that ignores it produces a run that uploaded nothing
 * rather than one that was told it had.
 *
 * Keyed as an exhaustive `Record` so the list below cannot drift from the union, and mirrored
 * byte-for-byte by the harness's own `HARNESS_BODY_CAPABILITIES` (the image is built from `src/`
 * plus typescript alone, so it can depend on no workspace package). The pairing is pinned by the
 * harness's `test/agent-capabilities.conformity.test.ts`, the same copy-plus-pin arrangement the
 * id/tool-name patterns use.
 */
export type HarnessBodyCapability = 'mcpServers' | 'skills' | 'designImages' | 'generateImages'

/** Operator-facing prose for each capability: what the body carried, in words. */
const HARNESS_BODY_CAPABILITY_LABELS: Record<HarnessBodyCapability, string> = {
  mcpServers: 'tool servers (MCP)',
  skills: 'skills',
  designImages: 'design pictures',
  generateImages: "the agent CLI's own image generation",
}

/** Every capability the handshake covers. Derived, so it cannot drift from the union. */
export const HARNESS_BODY_CAPABILITIES = Object.keys(
  HARNESS_BODY_CAPABILITY_LABELS,
) as HarnessBodyCapability[]

/** What a capability is, for an operator-facing message. */
export function describeHarnessBodyCapability(capability: HarnessBodyCapability): string {
  return HARNESS_BODY_CAPABILITY_LABELS[capability]
}

/** Whether a wire value names a capability this backend knows. */
export function isHarnessBodyCapability(value: unknown): value is HarnessBodyCapability {
  return (
    typeof value === 'string' && (HARNESS_BODY_CAPABILITIES as readonly string[]).includes(value)
  )
}

/**
 * Narrow a harness's reported capability list off untrusted JSON.
 *
 * Returns `undefined` for anything that is not an array (an image that predates the
 * handshake, or a transport that cannot forward it), and that is a DIFFERENT answer from `[]`,
 * which is an
 * image saying it parses none of them. {@link resolveHarnessCapabilitySupport} is where the two
 * diverge; collapsing them here would destroy the distinction before anyone could act on it.
 *
 * Names this backend does not know are dropped rather than kept as strings: a NEWER image
 * reporting a capability nothing here sends is not information this deployment can use, and
 * keeping it would put an unbounded value into a metric dimension downstream.
 */
export function parseHarnessBodyCapabilities(value: unknown): HarnessBodyCapability[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter(isHarnessBodyCapability)
}

/** A non-empty array: the wire shape of every capability that is simply a list. */
function isPopulatedList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

/**
 * What "the body carries this capability" means for each one, as an exhaustive `Record` so a new
 * member cannot be added without stating its own answer.
 *
 * A predicate per capability rather than one shape test over all of them, because the field shapes
 * genuinely differ and the wrong generalisation is SILENT in the worst direction: `designImages` is
 * an object (`{ url, token, files }`), so the populated-list test every list-shaped capability
 * shares reads it as absent, the handshake never fires for it, and an image that predates the field
 * ignores the manifest while the backend's prompt names a directory nothing wrote. That is
 * precisely the blind run this whole handshake exists to refuse.
 *
 * The KEY is still the body field name, which is what keeps the harness's own list a list of field
 * names and needs no second mapping there; only the emptiness test lives here.
 */
const HARNESS_BODY_CAPABILITY_CARRIED: Record<HarnessBodyCapability, (value: unknown) => boolean> =
  {
    mcpServers: isPopulatedList,
    skills: isPopulatedList,
    // A manifest with no files promises the agent nothing, exactly as an empty server list does.
    designImages: (value) =>
      typeof value === 'object' &&
      value !== null &&
      isPopulatedList((value as { files?: unknown }).files),
    // A plain flag, and the only shape here that is neither a list nor a manifest. `=== true`
    // rather than truthiness, because the field is the wire's own boolean and anything else in it
    // is a body this backend did not compose.
    generateImages: (value) => value === true,
  }

/**
 * Which capabilities a job body actually CARRIES, which is what the handshake is checked against.
 *
 * Read off the body rather than off the agent kind's declaration on purpose: a dispatch that
 * dropped every tool server for its own reasons (an unsupported harness, a missing credential)
 * promised the agent nothing and has nothing to verify. What must line up is the body and the
 * PROMPT, and the prompt is composed from the same resolution the body is.
 */
export function requiredHarnessCapabilities(
  body: Readonly<Record<string, unknown>>,
): HarnessBodyCapability[] {
  return HARNESS_BODY_CAPABILITIES.filter((capability) =>
    HARNESS_BODY_CAPABILITY_CARRIED[capability](body[capability]),
  )
}

/**
 * Read a harness's `POST /jobs` acceptance body into a {@link RunnerDispatchAck}.
 *
 * Every transport that speaks to a harness directly calls this rather than picking the field out
 * itself, so "what an ack looks like on the wire" is stated once. Returns undefined when the body
 * carries nothing the handshake can use, which the resolver reads as `unknown`: the same answer
 * a transport that never saw a response gives, and the right one: neither knows.
 */
export function readRunnerDispatchAck(body: unknown): RunnerDispatchAck | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const capabilities = (body as { capabilities?: unknown }).capabilities
  return Array.isArray(capabilities)
    ? { capabilities: capabilities.filter((entry): entry is string => typeof entry === 'string') }
    : undefined
}

/**
 * Whether the image can honour the capabilities a dispatch actually put in the body.
 *
 * - `supported`: the harness named every one of them. Nothing to say.
 * - `unknown`: the harness reported no list. The dispatch may be fine (any image at or past the
 *   version that added the capability serves it) or blind, and nothing here can tell which. It is
 *   reported as the gap in OBSERVABILITY it is, never as a fault of the run.
 * - `unsupported`: the harness reported a list and these capabilities are not in it. The prompt
 *   is already promising them, so this run cannot be honest whatever happens next.
 *
 * `required` is what the body CARRIES, not what the kind declares: a dispatch that dropped every
 * tool server for its own reasons promised nothing and has nothing to check.
 */
export type HarnessCapabilitySupport =
  | { kind: 'supported' }
  | { kind: 'unknown'; required: HarnessBodyCapability[] }
  | { kind: 'unsupported'; missing: HarnessBodyCapability[] }

export function resolveHarnessCapabilitySupport(
  required: readonly HarnessBodyCapability[],
  reported: readonly HarnessBodyCapability[] | undefined,
): HarnessCapabilitySupport {
  if (required.length === 0) return { kind: 'supported' }
  if (!reported) return { kind: 'unknown', required: [...required] }
  const missing = required.filter((capability) => !reported.includes(capability))
  return missing.length ? { kind: 'unsupported', missing } : { kind: 'supported' }
}

/**
 * What became of the blind job the refusal tried to stop: the transport's own
 * {@link RunnerJobStopOutcome}, plus the `failed` case that is a THROW at the port rather than a
 * returned value (see the port's doc for why).
 */
export type BlindJobStopOutcome = RunnerJobStopOutcome | 'failed'

/**
 * The one sentence that says whether the agent this run just refused is actually gone.
 *
 * Refusing the step and stopping the container are two different achievements, and only one of
 * them is guaranteed. A refusal that stayed silent about the difference would read, on every
 * backend, as the strongest case: `stopped`. It is not. A self-hosted pool whose manifest declares
 * no cancel has a full agent pass still running against the repo, free to push a branch and open a
 * pull request for a step the engine has already failed, and the person reading the failure is the
 * only one who can go and kill it. So each outcome gets its own words, and three of the four say
 * plainly that something may still be running.
 */
function describeBlindJobStop(stop: BlindJobStopOutcome): string {
  switch (stop) {
    case 'stopped':
      return 'The job was stopped, so nothing is still running against the repository.'
    case 'requested':
      return (
        'A cancel was sent to the runner pool, but this backend cannot confirm the job ended: ' +
        'check the pool for a run still working on this branch.'
      )
    case 'unsupported':
      return (
        'This runner backend offers no way to stop an accepted job, so the agent is probably ' +
        'still running: stop it on the runner and discard any branch or pull request it opens.'
      )
    case 'failed':
      return (
        'Stopping the job FAILED, so the agent is probably still running: stop it on the runner ' +
        'and discard any branch or pull request it opens.'
      )
  }
}

/**
 * The refusal a blind dispatch is failed with, naming the capability, the fix, WHOSE fix it is,
 * and whether the blind agent was actually stopped. Written for the person reading a failed run:
 * the fault is a runner image behind the backend, which is an operator action on the pool, not
 * anything the run's author can change.
 */
export function harnessCapabilityUnsupportedMessage(
  missing: readonly HarnessBodyCapability[],
  stop: BlindJobStopOutcome,
): string {
  const what = missing.map(describeHarnessBodyCapability).join(' and ')
  return (
    `The runner image serving this job does not support ${what}, which this step's prompt ` +
    'already tells the agent it has. Refused rather than run blind. Update the runner pool to ' +
    `the harness image this deployment expects, or remove the capability from the agent kind. ` +
    describeBlindJobStop(stop)
  )
}
