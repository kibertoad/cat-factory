// The account's skill catalog, as the workspace snapshot carries it (`snapshot.skills`). Four
// review playbooks and one build skill, so a surface that offers only the `review` group has
// one to leave out. Skills are what a team authors in its skill library; these are made up.
import type { AccountSkill, SkillSource, SkillSummary } from '@cat-factory/contracts'
import { orgAccount } from './accounts.stories.mocks'

export const skillCatalog: SkillSummary[] = [
  {
    id: 'skill_perf',
    name: 'Performance review',
    description: 'Hot paths, N+1 queries and unbounded loops.',
    group: 'review',
  },
  {
    id: 'skill_security',
    name: 'Security review',
    description: 'Auth checks, secrets in logs and untrusted input reaching a query.',
    group: 'review',
  },
  {
    id: 'skill_a11y',
    name: 'Accessibility review',
    description: 'Labels, focus order and contrast on changed screens.',
    group: 'review',
  },
  {
    id: 'skill_migrations',
    name: 'Migration review',
    description: 'Locking, backfills and a way back for every schema change.',
    group: 'review',
  },
  {
    id: 'skill_scaffold',
    name: 'Service scaffold',
    description: 'Creates a new service from the house template.',
    group: 'build',
  },
]

/** The repository the account syncs its skills from, synced on October 11. */
export const skillSource: SkillSource = {
  id: 'sks_playbooks',
  accountId: orgAccount.id,
  repoOwner: 'acme',
  repoName: 'engineering-playbooks',
  gitRef: 'main',
  dirPath: '.claude/skills',
  lastSyncedCommit: '9b3f20e1c4a7',
  lastSyncedAt: Date.UTC(2026, 9, 11, 7, 30),
  createdAt: Date.UTC(2026, 8, 20),
}

function accountSkill(
  summary: SkillSummary,
  dirName: string,
  overrides: Partial<AccountSkill> = {},
): AccountSkill {
  return {
    id: `src:${skillSource.id}:${dirName}`,
    name: summary.name,
    description: summary.description,
    instructions: `# ${summary.name}\n\n${summary.description}`,
    resources: [],
    group: summary.group,
    source: {
      sourceId: skillSource.id,
      path: `${skillSource.dirPath}/${dirName}/SKILL.md`,
      sha: '5d8e1f0',
    },
    pinnedCommit: skillSource.lastSyncedCommit,
    createdAt: Date.UTC(2026, 8, 20),
    updatedAt: Date.UTC(2026, 9, 11, 7, 30),
    ...overrides,
  }
}

/**
 * The account's synced catalog, as its settings list it: the performance review with two
 * resource files, the security review, and a scaffold whose manifest declares a group this build
 * does not know ("scafold"), so it is filed under Other.
 */
export const accountSkills: AccountSkill[] = [
  accountSkill(skillCatalog[0]!, 'performance-review', {
    resources: [
      { path: 'checklist.md', sha: 'a1c4e09', size: 2_310 },
      { path: 'examples/n-plus-one.ts', sha: 'b77d2f3', size: 1_045 },
    ],
  }),
  accountSkill(skillCatalog[1]!, 'security-review'),
  accountSkill(skillCatalog[4]!, 'service-scaffold', { group: 'other', declaredGroup: 'scafold' }),
]
