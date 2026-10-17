// The files of the `acme/platform` monorepo (`availableRepos` in `vcs.stories.mocks.ts`), for the
// pickers that browse a repository one folder at a time or search all of its paths. The files are
// made up. One list holds them, and each folder's listing is derived from it, so the folder
// browser and the path search show the same repository.
import type { RepoTreeEntry } from '@cat-factory/contracts'
import { platformRepo } from './vcs.stories.mocks'

export const PLATFORM_REPO_ID = platformRepo.githubId

function file(path: string): RepoTreeEntry {
  return { path, name: path.split('/').at(-1)!, type: 'file' }
}

/** Every file, sorted by path, as the recursive files read answers (it drops the folders). */
export const platformFiles: RepoTreeEntry[] = [
  'README.md',
  'apps/admin/package.json',
  'apps/admin/src/main.ts',
  'apps/web/package.json',
  'apps/web/src/main.ts',
  'docker-compose.yml',
  'docs/adr/0001-monorepo-layout.md',
  'docs/adr/0002-shared-auth-client.md',
  'docs/architecture.md',
  'docs/onboarding.md',
  'docs/runbook.md',
  'package.json',
  'packages/auth/README.md',
  'packages/auth/package.json',
  'packages/billing-api/README.md',
  'packages/billing-api/docs/invoicing.md',
  'packages/billing-api/package.json',
  'packages/shared/index.ts',
  'packages/shared/package.json',
]
  .sort((a, b) => a.localeCompare(b))
  .map(file)

/**
 * The billing API's numbered SQL migrations, more than the path search shows at once. A story
 * adds them to `platformFiles` to show the cap.
 */
export const billingMigrations: RepoTreeEntry[] = Array.from({ length: 64 }, (_, i) =>
  file(`packages/billing-api/migrations/${String(i + 1).padStart(4, '0')}.sql`),
)

/**
 * One folder of `files` as the folder read answers: its subfolders, then its files, each group
 * by name. `path` is '' for the root.
 */
export function folderOf(files: RepoTreeEntry[], path: string): RepoTreeEntry[] {
  const prefix = path ? `${path}/` : ''
  const dirs = new Set<string>()
  const leaves: RepoTreeEntry[] = []
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue
    const rest = f.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash === -1) leaves.push(f)
    else dirs.add(rest.slice(0, slash))
  }
  const folders: RepoTreeEntry[] = [...dirs].map((name) => ({
    path: `${prefix}${name}`,
    name,
    type: 'dir',
  }))
  const byName = (a: RepoTreeEntry, b: RepoTreeEntry) => a.name.localeCompare(b.name)
  return [...folders.sort(byName), ...leaves.sort(byName)]
}
