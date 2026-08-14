import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'
import { BINARY_OUTPUT_TRAIT, BINARY_STORAGE_TRAIT } from './traits.js'

// ---------------------------------------------------------------------------
// The built-in `media-generator` agent kind — the FIRST built-in to carry the `binary-output`
// trait, and the one that makes the Media task type work with nothing configured.
//
// Everything it needs already existed and was reachable only by a deployment writing its own
// agent kind: the trait's brief (`.cat-context/binary-output/brief.md`) names the generative
// integrations the step selected, the content types it must deliver and the storage service to
// deliver them through; run admission refuses a selection that does not resolve; the fenced
// ```binary-outputs block is read back onto the step; and `binaryOutput.comparison` turns the
// step into two dispatches with a human keep-decision between them. See
// docs/initiatives/binary-output-foundational-storage.md for the whole model.
//
// What this kind adds is a DEFAULT: a shipped role prompt, and a shipped pipeline whose step
// already selects the platform's own asset storage, so generating an image is picking a task
// type rather than a week of registration work.
//
// It carries BOTH traits, and the second one is the precondition. `binary-storage` refuses the
// run up front when the account has no content storage configured, which is exactly right for
// this kind because the storage it ships pointing at IS that store (a local deployment gets the
// filesystem with nothing configured; every other one picks a backend in account settings). A
// deployment storing through its own object service instead registers its own binary-output kind
// and omits the trait: the trait is a statement about where THIS kind's bytes go, not about
// binary output in general, which is why it is declared here rather than implied by the sibling.
//
// It is read-only over the checkout (`container-explore`) and opens no pull request: its
// deliverable is stored through an API, and the trait guidance is explicit that binaries are
// never committed to the repository. The checkout is still worth having — a step scoped to "the
// icons this app is missing" is answered from the repo as often as from a context service.
// ---------------------------------------------------------------------------

export const MEDIA_GENERATOR_AGENT_KIND = 'media-generator'

const MEDIA_GENERATOR_SYSTEM_PROMPT =
  'You are a production artist working one MEDIA task: your deliverable is the generated ' +
  'binary artifacts themselves (images, 3D models, audio or video, whichever this step asks ' +
  'for), stored through the storage service the platform gave you. You write no code and open ' +
  'no pull request.\n\n' +
  'Work in this order:\n' +
  '1. Read the brief the platform placed in your context before anything else. It is the only ' +
  'authority on what you may generate with, what you must deliver, and where it goes; the task ' +
  'description says what to make, and the brief says how.\n' +
  '2. Settle SCOPE before you spend a generation: what subjects the task actually calls for, ' +
  'how many, and what each one has to depict. Where the step selected context services or the ' +
  'checkout describes the subjects, read them rather than inventing a list.\n' +
  '3. Generate, then store each artifact through the storage contract and keep the location the ' +
  'service returns. An artifact you generated and did not store does not exist.\n\n' +
  'Two things decide whether this run is usable afterwards. Every artifact must be DECLARED in ' +
  'the machine-read block at the end of your reply, with the location the storage service gave ' +
  'you: that block is the only record anyone has of where the work went. And everything you ' +
  'could NOT do belongs in your report by name — a subject you skipped, an integration whose ' +
  'credential was unset, a format nothing available could emit, an upload that failed. A partial ' +
  'delivery that says what is missing is useful; one that reads as complete is not.\n\n' +
  'Do not describe pictures you did not generate, and do not substitute a written description ' +
  'for an artifact you could not produce.'

export const MEDIA_AGENT_KINDS: AgentKindDefinition[] = [
  {
    kind: MEDIA_GENERATOR_AGENT_KIND,
    systemPrompt: MEDIA_GENERATOR_SYSTEM_PROMPT,
    // `binary-output` earns the brief, the admission checks and the declaration read-back;
    // `binary-storage` is the precondition on the account store this kind's shipped storage
    // service is backed by (see the header).
    traits: [BINARY_OUTPUT_TRAIT, BINARY_STORAGE_TRAIT],
    // Read-only checkout of the primary repo's base branch. No `structuredOutput`: the
    // deliverable is the fenced declaration block the engine parses off the reply, not a JSON
    // object, so a schema here would fail every run that did its job.
    agent: { surface: 'container-explore', clone: { branch: 'base' } },
    presentation: {
      label: 'Media Generator',
      icon: 'i-lucide-image-plus',
      color: '#f472b6',
      description:
        'Generates images, 3D models or other binary assets through the generative integrations ' +
        'the step selects, stores each one through the selected asset storage, and reports where ' +
        'every artifact landed.',
      category: 'design',
      // The whole point of the Media task type is that this works out of the box, so it is
      // offered in the default palette rather than behind the tier dial.
      tier: 'basic',
      // Only ever useful in a media pipeline: its deliverable is an asset, and a build, review
      // or document preset has nothing to do with one.
      purposes: ['media'],
      // No result view: `PipelineStep.binaryOutputs` is rendered by the shared
      // `BinaryOutputReport` section, which the generic step-detail panel already shows. A
      // declared view here would be a second window saying the same thing (and would be blind
      // to a step whose artifacts were recorded under an overriding kind).
    },
  },
]

/**
 * Register the media-generator kind on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerMediaAgent(registry: AgentKindRegistry): void {
  registry.registerAll(MEDIA_AGENT_KINDS)
}
