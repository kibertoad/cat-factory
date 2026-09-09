import type { DescriptorField, GitHubRepo } from '@cat-factory/contracts'
import { parseRepoRef } from '../assistant.logic.js'
import type { AssistantActionDefinition, AssistantActionOutcome } from '../types.js'
import { needsInput, performed } from '../types.js'
import type { AssistantRepoDeps } from './deps.js'
import { readArgument } from './shared.js'

// ---------------------------------------------------------------------------
// "Add <this repository> as a service": the assistant's route to the board's own
// add-service-from-repo import, addressed by the URL a person has in their clipboard instead of by
// the numeric provider id the API takes.
//
// The URL is parsed by the SHARED parser (`repo-url.ts`), the same one the repository picker
// resolves a pasted URL with, so GitHub and GitLab shapes (subgroups, `/-/`, `/tree/<ref>/<path>`)
// are understood identically on both surfaces and a self-managed host is not a special case. A
// bare `owner/name` slug is accepted beside it, because that is the shape of the near-misses this
// action itself offers when a URL names a repository the workspace cannot see (`parseRepoRef`).
//
// The repository must already be PROJECTED for this workspace. That is not a shortcut: the
// projection is what the workspace's VCS connection can reach, so a URL that is not in it names
// either a repository the deployment has no credential for or one whose connection has not synced
// and inventing a link for it would create a service frame whose every run fails at clone time.
// The turn says which repository it could not find instead, with the near-misses by name.
// ---------------------------------------------------------------------------

const PARAMETERS: readonly DescriptorField[] = [
  {
    key: 'repoUrl',
    label: 'Repository URL',
    help: 'The web URL of the GitHub or GitLab repository, copied verbatim, e.g. https://github.com/acme/payments. An owner/name slug such as acme/payments is accepted too.',
    required: true,
  },
  {
    key: 'directory',
    label: 'Subdirectory',
    type: 'path',
    help: 'For a monorepo only: the path inside the repository this service lives in, e.g. packages/api. Omit for a whole-repo service.',
  },
]

/**
 * Repositories whose NAME matches, under any owner: what a wrong-owner URL most often meant.
 *
 * `owner/name` slugs, and that shape is load-bearing rather than cosmetic: they are offered as the
 * ANSWER to "which repository did you mean?", so each one has to be a value this action's own
 * `repoUrl` argument accepts (see `parseRepoRef`). A candidate the next turn would refuse as
 * unreadable is a question with no acceptable answer.
 */
function nearMisses(repos: readonly GitHubRepo[], name: string, limit = 5): string[] {
  const wanted = name.toLowerCase()
  return repos
    .filter((repo) => repo.name.toLowerCase() === wanted)
    .slice(0, limit)
    .map((repo) => `${repo.owner}/${repo.name}`)
}

export function addServiceFromRepoAction(deps: AssistantRepoDeps): AssistantActionDefinition {
  return {
    actionId: 'add-service-from-repo',
    purpose:
      'Put a service on the board backed by an existing GitHub or GitLab repository, named by ' +
      'its web URL, so tasks can be filed against it and agents work on a real checkout of it.',
    examples: [
      'add https://github.com/acme/payments as a service',
      'put the repo https://gitlab.com/acme/platform/billing on the board',
      'add packages/api from https://github.com/acme/monorepo as a service',
    ],
    parameters: PARAMETERS,
    async run({ workspaceId, arguments: args }): Promise<AssistantActionOutcome> {
      const url = readArgument(args, 'repoUrl')
      if (url === undefined) return needsInput('missing_argument', 'repoUrl')
      const parsed = parseRepoRef(url)
      if (!parsed) return needsInput('unreadable_repository_url', 'repoUrl')

      const repos = await deps.listRepos(workspaceId)
      const repo = repos.find(
        (candidate) =>
          candidate.owner.toLowerCase() === parsed.owner.toLowerCase() &&
          candidate.name.toLowerCase() === parsed.repo.toLowerCase(),
      )
      if (!repo) {
        return needsInput('unknown_repository', 'repoUrl', nearMisses(repos, parsed.repo))
      }

      // The subdirectory comes from the argument when the person named one, else from the
      // reference itself when it points INTO the tree (`/tree/<ref>/packages/api`). A URL that
      // deep is a statement about which part of the repository is meant, and dropping it would
      // silently create a whole-repo service for a request that named a subtree. Both have been
      // through the shared path rule by the time they get here: the stated one through the turn's
      // own descriptor validation, the recovered one inside `parseRepoRef`.
      const directory = readArgument(args, 'directory') ?? parsed.directory

      // `created` comes from the board service's own DISPOSITION, never from comparing the
      // returned frame against the board as it stood a moment ago. That comparison was wrong in
      // the one case the flag exists for: the account-wide dedupe answers with the frame of a
      // service homed on ANOTHER board, which was never among this board's blocks, so a
      // first-time mount read as a fresh create. Only the operation knows which path it took.
      const { block, disposition } = await deps.addServiceFromRepo(workspaceId, {
        repoGithubId: repo.githubId,
        // The monorepo flag rides the add request, as it does from the import modal: naming a
        // subdirectory IS the statement that the repository hosts more than one service.
        ...(directory === undefined ? {} : { directory, isMonorepo: true }),
      })
      return performed({
        actionId: 'add-service-from-repo',
        service: { blockId: block.id, title: block.title },
        repo: { owner: repo.owner, name: repo.name, directory: directory ?? null },
        created: disposition === 'created',
      })
    },
  }
}
