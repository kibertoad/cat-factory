import type { DescriptorField, GitHubRepo } from '@cat-factory/contracts'
import { isSafeRepoDirPath, parseRepoWebUrl } from '@cat-factory/contracts'
import { serviceFramesOf } from '../assistant.logic.js'
import type { AssistantActionDefinition, AssistantActionOutcome } from '../types.js'
import { needsInput, performed } from '../types.js'
import type { AssistantBoardDeps, AssistantRepoDeps } from './deps.js'
import { readArgument } from './shared.js'

// ---------------------------------------------------------------------------
// "Add <this repository> as a service": the assistant's route to the board's own
// add-service-from-repo import, addressed by the URL a person has in their clipboard instead of by
// the numeric provider id the API takes.
//
// The URL is parsed by the SHARED parser (`repo-url.ts`), the same one the repository picker
// resolves a pasted URL with, so GitHub and GitLab shapes (subgroups, `/-/`, `/tree/<ref>/<path>`)
// are understood identically on both surfaces and a self-managed host is not a special case.
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
    help: 'The web URL of the GitHub or GitLab repository, copied verbatim, e.g. https://github.com/acme/payments.',
    required: true,
  },
  {
    key: 'directory',
    label: 'Subdirectory',
    type: 'path',
    help: 'For a monorepo only: the path inside the repository this service lives in, e.g. packages/api. Omit for a whole-repo service.',
  },
]

/** Repositories whose NAME matches, under any owner: what a wrong-owner URL most often meant. */
function nearMisses(repos: readonly GitHubRepo[], name: string, limit = 5): string[] {
  const wanted = name.toLowerCase()
  return repos
    .filter((repo) => repo.name.toLowerCase() === wanted)
    .slice(0, limit)
    .map((repo) => `${repo.owner}/${repo.name}`)
}

export function addServiceFromRepoAction(
  board: AssistantBoardDeps,
  deps: AssistantRepoDeps,
): AssistantActionDefinition {
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
      const parsed = parseRepoWebUrl(url)
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

      // The subdirectory comes from the argument when the person named one, else from the URL
      // itself when it points INTO the tree (`/tree/<ref>/packages/api`). A URL that deep is a
      // statement about which part of the repository is meant, and dropping it would silently
      // create a whole-repo service for a request that named a subtree.
      // A stated directory has already been through the shared `path` validator (the turn refuses
      // an unsafe one before any action runs); one recovered from the URL has not, so it is
      // checked here against the same rule rather than trusted for having come from a link.
      const stated = readArgument(args, 'directory')
      const fromUrl =
        parsed.kind === 'dir' && parsed.path !== '' && isSafeRepoDirPath(parsed.path)
          ? parsed.path
          : undefined
      const directory = stated ?? fromUrl

      // Read BEFORE the write, so `created` is derived from what the board held rather than
      // guessed from the response: `addServiceFromRepo` answers with a frame either way, and the
      // one case it MOUNTS an existing org service is exactly the one a person needs told apart
      // from a fresh import.
      const before = new Set(
        serviceFramesOf(await board.listBoardBlocks(workspaceId)).map((f) => f.id),
      )
      const block = await deps.addServiceFromRepo(workspaceId, {
        repoGithubId: repo.githubId,
        // The monorepo flag rides the add request, as it does from the import modal: naming a
        // subdirectory IS the statement that the repository hosts more than one service.
        ...(directory === undefined ? {} : { directory, isMonorepo: true }),
      })
      return performed({
        actionId: 'add-service-from-repo',
        service: { blockId: block.id, title: block.title },
        repo: { owner: repo.owner, name: repo.name, directory: directory ?? null },
        created: !before.has(block.id),
      })
    },
  }
}
