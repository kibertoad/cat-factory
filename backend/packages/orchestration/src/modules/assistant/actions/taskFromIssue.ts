import type { DescriptorField } from '@cat-factory/contracts'
import type { Block } from '@cat-factory/kernel'
import { issueRepoSlug, matchServiceByName, serviceFramesOf } from '../assistant.logic.js'
import type { AssistantActionDefinition, AssistantActionOutcome } from '../types.js'
import { needsInput, performed } from '../types.js'
import type { AssistantBoardDeps, AssistantIssueDeps, AssistantRepoDeps } from './deps.js'
import { readArgument, resolveNamedService, serviceTitles } from './shared.js'

// ---------------------------------------------------------------------------
// "File this issue as a task": the assistant's route to the board's own create-task-from-issue
// flow, addressed by the URL a person is looking at rather than by a source id plus an external
// key plus a container id.
//
// The turn resolves three things the API takes as given, and each one is computed rather than
// guessed:
//
//  - WHICH TRACKER the URL belongs to is answered by the providers themselves, by asking every
//    OFFERED source to parse it. Two answers is a question, never a pick (see `matchIssueSources`),
//    asked about the `source` argument: a request may state it outright ("file PROJ-7 from Jira")
//    and an answered clarification fills it in. It only ever BREAKS A TIE among the providers'
//    own answers, so naming a tracker cannot conjure one that does not read the reference.
//  - WHICH SERVICE the task is filed under is the one whose linked repository the issue lives in,
//    when the issue is repo-backed and exactly one service is linked to that repository. Anything
//    else (a Jira ticket with no repository in its URL, a monorepo repository backing several
//    services, a repository on no board frame) is a question with the board's services attached.
//  - The ISSUE ITSELF is imported first, because the task's title and description come from it
//    and because an unreachable issue must fail before a block exists rather than after.
//
// The heavy refusals stay where they already live: a disabled or unconfigured source and an issue
// already filed as a task are both raised by the services underneath, and reach the SPA as the
// same errors the import modal produces.
// ---------------------------------------------------------------------------

const PARAMETERS: readonly DescriptorField[] = [
  {
    key: 'issueUrl',
    label: 'Issue URL',
    help: 'The web URL of the issue or ticket, copied verbatim, e.g. https://github.com/acme/api/issues/12 or https://acme.atlassian.net/browse/PROJ-7.',
    required: true,
  },
  {
    key: 'service',
    label: 'Service',
    help: 'The name of the service to file the task under. Omit it when the request does not say, and the platform uses the service backed by the issue’s own repository.',
  },
  {
    key: 'source',
    label: 'Tracker',
    help: 'Which tracker the issue lives in, e.g. jira, linear, github, gitlab. Only worth stating when the reference could belong to more than one, such as a bare ticket key. Omit it and the connected trackers are asked which of them recognises the reference.',
  },
]

/**
 * The service frame backed by the repository the issue lives in, or null when that cannot be
 * decided from the board alone.
 *
 * Null covers three genuinely different states, and they are collapsed ON PURPOSE at this level:
 * a tracker with no repository at all (Jira, Linear), a repository this workspace does not
 * project, and a repository backing SEVERAL services (a monorepo, where the link cannot say which
 * subdirectory an issue belongs to). The caller's next move is the same question in all three
 * ("which service?"), and the shortlist it offers is the board's services either way.
 */
async function serviceForIssueRepo(
  repos: AssistantRepoDeps,
  workspaceId: string,
  frames: readonly Block[],
  externalId: string,
): Promise<Block | null> {
  const parsed = issueRepoSlug(externalId)
  if (!parsed) return null
  const projected = await repos.listRepos(workspaceId)
  const repo = projected.find(
    (candidate) =>
      candidate.owner.toLowerCase() === parsed.owner.toLowerCase() &&
      candidate.name.toLowerCase() === parsed.repo.toLowerCase(),
  )
  if (!repo) return null
  // ONE batched read of the account services behind the board's frames, the sole repo ⇄ frame
  // linkage (`Service.repoGithubId`), rather than a lookup per frame.
  const services = await repos.listServicesForFrames(frames.map((frame) => frame.id))
  const linked = services.filter((service) => service.repoGithubId === repo.githubId)
  // Several means a monorepo whose subdirectories are separate services: which one an issue
  // belongs to is not something the repository link can answer, so it stays a question.
  if (linked.length !== 1) return null
  return frames.find((frame) => frame.id === linked[0]!.frameBlockId) ?? null
}

export function createTaskFromIssueAction(
  board: AssistantBoardDeps,
  deps: AssistantIssueDeps,
  repos: AssistantRepoDeps | undefined,
): AssistantActionDefinition {
  return {
    actionId: 'create-task-from-issue',
    purpose:
      'File a board task from a tracker issue named by its URL (a GitHub or GitLab issue, a Jira ' +
      'or Linear ticket), importing the issue and linking it to the task as agent context.',
    examples: [
      'create a task from https://github.com/acme/api/issues/12',
      'file https://acme.atlassian.net/browse/PROJ-7 as a task on the billing service',
    ],
    parameters: PARAMETERS,
    async run({ workspaceId, arguments: args, editor, userId }): Promise<AssistantActionOutcome> {
      const url = readArgument(args, 'issueUrl')
      if (url === undefined) return needsInput('missing_argument', 'issueUrl')

      const recognised = await deps.matchIssueSources(workspaceId, url)
      if (recognised.length === 0) return needsInput('unknown_issue_source', 'issueUrl')

      // `source` is a TIE-BREAK among the trackers that recognised the reference, never a filter
      // over them. WHICH trackers can read a reference is the providers' answer and nobody else's,
      // so a stated name that is none of them says the NAME was wrong, not that the reference is
      // unreadable: dropping to zero there would turn a pasted GitHub URL the model labelled
      // `jira` into "no connected tracker recognises that link", which is both false and a remedy
      // (go and connect one) that fixes nothing. Ignored, the answer is the one the providers gave.
      const stated = readArgument(args, 'source')?.toLowerCase()
      const chosen =
        stated === undefined ? recognised : recognised.filter((match) => match.source === stated)
      const matches = chosen.length === 0 ? recognised : chosen
      if (matches.length > 1) {
        // The question names the `source` FIELD, not the URL that was fine: a bare `PROJ-12` is
        // legitimately both a Jira key and a Linear identifier, and what is missing is which
        // tracker was meant. Naming `issueUrl` here would offer tracker ids as the answer to a
        // question about a URL, and the next turn has no `issueUrl` reading that accepts one.
        return needsInput(
          'ambiguous_issue_source',
          'source',
          matches.map((match) => match.source),
        )
      }
      const { source } = matches[0]!

      // Imported BEFORE the container is resolved: the issue is what the task is made of, so an
      // unreachable or unauthorised one must fail while the board is still untouched.
      const issue = await deps.importIssue(workspaceId, source, url)

      const frames = serviceFramesOf(await board.listBoardBlocks(workspaceId))
      const named = readArgument(args, 'service')
      let container: Block | null = null
      if (named !== undefined) {
        const resolved = resolveNamedService(matchServiceByName(frames, named), 'service')
        if (resolved.kind !== 'one') return resolved.outcome
        container = resolved.frame
      } else if (repos) {
        container = await serviceForIssueRepo(repos, workspaceId, frames, issue.externalId)
      }
      if (!container) {
        return needsInput('unresolved_issue_service', 'service', serviceTitles(frames))
      }

      const { block } = await deps.createTaskFromIssue({
        workspaceId,
        containerId: container.id,
        source,
        externalId: issue.externalId,
        editor,
        createdBy: userId,
      })
      return performed({
        actionId: 'create-task-from-issue',
        task: { blockId: block.id, title: block.title },
        service: { blockId: container.id, title: container.title },
        issue: { source, externalId: issue.externalId, url: issue.url },
      })
    },
  }
}
