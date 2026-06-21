import { linkRepo } from './linkRepo.js'

// Small CLI to link a real GitHub repo to a board service frame in local mode:
//   node dist/link-repo.js <workspaceId> <frameBlockId> <owner/repo>
// Reads GITHUB_PAT + DATABASE_URL from the environment (load a .env via Node's
// `--env-file-if-exists`). Seeds the github_installations + github_repos rows the
// container executor resolves a run's target repo from.
const [workspaceId, frameBlockId, repo] = process.argv.slice(2)

if (!workspaceId || !frameBlockId || !repo) {
  console.error('usage: link-repo <workspaceId> <frameBlockId> <owner/repo>')
  process.exit(2)
}

linkRepo({ workspaceId, frameBlockId, repo })
  .then((r) => {
    console.log(
      `linked ${r.owner}/${r.name} (#${r.githubId}) → frame ${frameBlockId} ` +
        `[default branch: ${r.defaultBranch}, installation ${r.installationId}]`,
    )
  })
  .catch((err: unknown) => {
    console.error('link failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
