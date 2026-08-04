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
  const { exposed, filteredGroups, writeToolsHidden } = selection
  const groups = [...new Set(exposed.map((tool) => tool.group))]
  const sections: string[] = [
    "cat-factory runs coding agents against a team's real repositories: a board of services and " +
      'tasks, each task run through a pipeline of agent steps that opens and merges pull requests. ' +
      'These tools are the public API of ONE workspace, the one the configured key belongs to.',
    `Available tool groups:\n${groups
      .map((group) => `- ${group}: ${CAT_FACTORY_TOOL_GROUPS[group]}`)
      .join('\n')}`,
    'Two things here cost real money and real time, so confirm with the user before calling them: ' +
      '`tasks_start` / `tasks_retry` and `jobs_create` each begin an agent run against a real ' +
      'repository, and `notifications_act` can merge a pull request. Everything else is cheap.',
    '`webhook_set` and `webhook_delete` change where this workspace pushes its notifications, run ' +
      'events and health alerts, so they can silently cut off or redirect an integration someone ' +
      'else depends on. Confirm with the user, and read `webhook_get` first.',
    'A run PARKS on a human decision and then waits indefinitely by design; it is not stuck. Read ' +
      'the park with `decisions_list` and answer it with the other `decisions_*` tools, or leave ' +
      'it for a person.',
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
  // The omissions are stated in the same voice as the filters above, and for the same reason: a
  // model that cannot find a way to watch a run live should learn that the platform streams and
  // that a tool call is the wrong shape for it, rather than concluding the platform does not.
  sections.push(
    `Not available as tools:\n${CAT_FACTORY_OMITTED_OPERATIONS.map(
      (omitted) => `- ${omitted.route}: ${omitted.reason}`,
    ).join('\n')}`,
  )
  return sections.join('\n\n')
}
