import type { ToolSelection } from './config.ts'
import { CAT_FACTORY_OMITTED_OPERATIONS, CAT_FACTORY_TOOL_GROUPS } from './tools.generated.ts'

// The server's `instructions`: the one piece of prose a model reads before it reads any tool.
//
// It exists to answer the three questions the tool list cannot. What is this deployment (a model
// asked to "check the failing run" has no idea it is talking to an agent platform). What is
// deliberately NOT here, and what to use instead (an absent capability reads as an unsupported
// one, and the model then tells its user the platform cannot do it). And which of the things it
// can see cost real money or real time — because on this surface, some do.

/**
 * The server's instructions for a tool selection.
 *
 * Takes the SELECTION rather than the options it came from: what a model needs told is what was
 * actually withheld, and reading that back off the options would be a second derivation of it,
 * free to disagree with the first.
 */
export function buildInstructions(selection: ToolSelection): string {
  const { exposed, filteredGroups, writeToolsHidden, deniedTools, toolsAllowListed } = selection
  const groups = [...new Set(exposed.map((tool) => tool.group))]
  // Nullable entries so a section that has nothing to say can decline to appear, rather than every
  // caller having to keep the push order in step with the narrative order by hand.
  const sections: (string | null)[] = [
    "cat-factory runs coding agents against a team's real repositories: a board of services and " +
      'tasks, each task run through a pipeline of agent steps that opens and merges pull requests. ' +
      'These tools are the public API of ONE workspace, the one the configured key belongs to.',
    `Available tool groups:\n${groups
      .map((group) => `- ${group}: ${CAT_FACTORY_TOOL_GROUPS[group]}`)
      .join('\n')}`,
    costlyTools(exposed),
    'A run PARKS on a human decision and then waits indefinitely by design; it is not stuck. Read ' +
      'the park with `decisions_list` and answer it with the other `decisions_*` tools, or leave ' +
      'it for a person.',
    // The two absent operations are the platform's live channels, so "how do I watch a run" is the
    // question this surface most needs answered in prose. Without it a model either invents a
    // streaming tool, calls the poll in a tight loop, or reports one non-terminal reading as the
    // outcome, and the last of those is the one nobody catches, because it looks like an answer.
    'To WATCH work, poll rather than stream: `tasks_get_run` for a task run, `jobs_get` for a ' +
      'headless job. An agent step takes minutes, so poll every 15-30 seconds and say so to the ' +
      'user instead of going quiet. Keep polling until the status is terminal (`done`, `failed`, ' +
      '`cancelled`) or until `decisions_list` shows a park to answer; anything else is a run still ' +
      'in flight, and reporting it as the outcome is wrong rather than early.',
    'Results are JSON. Lists are keyset-paginated: pass the `cursor` a page returns to get the ' +
      'next one, and stop when it comes back null (an empty page with a cursor is normal).',
  ]
  if (writeToolsHidden) {
    sections.push(
      'This server was started READ-ONLY: only the tools that change nothing are exposed. The ' +
        'deployment supports creating and running tasks; you cannot do it from here.',
    )
  }
  if (filteredGroups.length > 0) {
    sections.push(
      `The operator switched off these tool groups on THIS server: ${filteredGroups.join(', ')}. ` +
        'The deployment still supports them; they are not reachable from here.',
    )
  }
  // The per-tool filters are stated in the same voice and for the same reason as the group one. The
  // deny-list matters most: it is the filter an operator reaches for to keep ONE capability away
  // from a model, and a model that reads the absence as a missing platform feature will offer to do
  // it some other way instead of asking the person who switched it off.
  if (deniedTools.length > 0) {
    sections.push(
      `The operator withheld these individual tools on THIS server: ${deniedTools.join(', ')}. ` +
        'The deployment still supports them; do not look for another route to the same effect.',
    )
  }
  if (toolsAllowListed) {
    sections.push(
      "This server exposes an explicitly chosen subset of the deployment's tools, so what you " +
        'can see is not the whole API. Everything listed works; anything you expect and cannot ' +
        'find was left out here on purpose.',
    )
  }
  // The omissions are stated in the same voice as the filters above, and for the same reason: a
  // model that cannot find a way to watch a run live should learn that the platform streams and
  // that a tool call is the wrong shape for it, rather than concluding the platform does not.
  sections.push(
    `Not available as tools:\n${CAT_FACTORY_OMITTED_OPERATIONS.map(
      (omitted) => `- ${omitted.route}: ${omitted.reason}`,
    ).join('\n')}`,
  )
  return sections.filter(Boolean).join('\n\n')
}

/**
 * The "check with a human first" section, or null when nothing exposed here needs one.
 *
 * DERIVED from the generated table's own `destructive` hint rather than restating the tool names in
 * prose: a list written here would be a second declaration of which tools spend, free to disagree
 * with the one a host reads off the annotations, and it would go on naming a tool the operator has
 * withheld on this server. A model told to be careful with a tool it cannot see learns that this
 * prose is not about the server in front of it.
 */
function costlyTools(exposed: ToolSelection['exposed']): string | null {
  const costly = exposed.filter((tool) => tool.hints?.destructive)
  if (costly.length === 0) return null
  const exposes = (name: string): boolean => costly.some((tool) => tool.name === name)
  const lines = [
    'Confirm with the user before calling these, because each does something a person cannot ' +
      `simply undo: ${costly.map((tool) => `\`${tool.name}\``).join(', ')}.`,
  ]
  // Each consequence is stated only where the tool that has it survived the filters, for the same
  // reason the names are derived rather than restated: prose describing a capability this server does
  // not serve teaches a model that the prose is not about the server in front of it.
  if (['tasks_start', 'tasks_retry', 'jobs_create'].some(exposes)) {
    lines.push(
      'Starting, retrying or creating work begins an agent run against a real repository: real ' +
        'model spend, real time.',
    )
  }
  if (exposes('notifications_act')) {
    lines.push('Acting on a notification can merge a pull request.')
  }
  if (exposes('tasks_delete')) {
    lines.push('A deleted task does not come back.')
  }
  // The webhook pair is the one whose damage is INVISIBLE from here: the tool answers 200 either
  // way, and what broke is a receiver somewhere else that simply stops hearing from this workspace.
  if (['webhook_set', 'webhook_delete'].some(exposes)) {
    lines.push(
      'Changing the outbound webhook redirects or cuts off where this workspace pushes its ' +
        'notifications, run events and health alerts, and the signing secret it replaces cannot ' +
        'be read back. Read `webhook_get` first.',
    )
  }
  // Only where there IS something else. A filter can narrow this server down to the spending tools
  // alone (an allow-list naming just `tasks_start` is the realistic one), and a closing sentence
  // about everything else would then be describing tools the model cannot see, which teaches it
  // that this prose is not about the server in front of it.
  if (exposed.length > costly.length) lines.push('Everything else here is cheap.')
  return lines.join(' ')
}
