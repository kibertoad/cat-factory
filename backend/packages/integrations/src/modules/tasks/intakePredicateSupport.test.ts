import { describe, expect, it } from 'vitest'
import type {
  IssueIntakePredicate,
  IssueIntakeQuery,
  TaskSourceProvider,
} from '@cat-factory/kernel'
import { GitHubIssuesProvider } from './GitHubIssuesProvider.js'
import { GitLabIssuesProvider } from './GitLabIssuesProvider.js'
import { JiraProvider } from './JiraProvider.js'
import { LinearTaskProvider } from './LinearTaskProvider.js'
import { buildGitHubIntakeQuery } from './github-issues.logic.js'
import { buildGitLabIntakeSearch } from './gitlab-issues.logic.js'
import { buildJiraIntakeJql } from './jira.logic.js'
import { buildLinearIntakeFilter } from './linear.logic.js'

// The drift guard behind `TaskSourceProvider.ignoredIntakePredicates`.
//
// That list is DECLARED rather than derived, because the four vendor grammars (JQL text, a
// GraphQL filter tree, GitHub search qualifiers, GitLab request parameters) share no shape to
// inspect — so what keeps it honest has to be a test, and a test that RESTATES the list would
// keep passing through exactly the change it exists to catch.
//
// So nothing here names which predicates a source applies. Each source's compiler is run twice,
// once with the predicate and once without, and a predicate that leaves the compiled request
// byte-identical is one the vendor never sees. That verdict is read off the compiler itself, so
// teaching GitLab to send `issue_type` fails this until the declaration drops it, and dropping a
// predicate from a compiler fails it until the declaration names it.

/** A board leg for every built-in source, so one base query compiles on all of them. */
const BOARD: IssueIntakeQuery['board'] = {
  jiraProjectKey: 'ENG',
  linearTeamId: 'team_9f3',
  githubRepo: 'acme/web',
  gitlabProject: 'acme/group/web',
}

const BASE: IssueIntakeQuery = { board: BOARD, limit: 5 }

/**
 * One distinctive value per predicate. The values differ from each other on purpose: two
 * predicates compiling the same literal would let one stand in for the other's evidence.
 */
const PREDICATE_VALUES: Record<IssueIntakePredicate, Partial<IssueIntakeQuery>> = {
  titleFragment: { titleFragment: 'crash on save' },
  labels: { labels: ['regression'] },
  issueType: { issueType: 'defect' },
  unassignedOnly: { unassignedOnly: true },
}

const PREDICATES = Object.keys(PREDICATE_VALUES) as IssueIntakePredicate[]

/** Each built-in source: its provider (which declares) beside its compiler (which decides). */
const SOURCES: { provider: TaskSourceProvider; compile: (query: IssueIntakeQuery) => unknown }[] = [
  // The providers are never called here, only read, so a stub dependency bag is enough.
  { provider: new JiraProvider(), compile: buildJiraIntakeJql },
  { provider: new LinearTaskProvider(), compile: buildLinearIntakeFilter },
  { provider: new GitHubIssuesProvider({} as never), compile: buildGitHubIntakeQuery },
  {
    provider: new GitLabIssuesProvider({} as never),
    compile: (query) => buildGitLabIntakeSearch(query, { limit: query.limit, page: 1 }),
  },
]

describe('intake predicate support', () => {
  for (const { provider, compile } of SOURCES) {
    it(`${provider.kind} declares exactly the intake predicates its query drops`, () => {
      const baseline = JSON.stringify(compile(BASE))
      const dropped = PREDICATES.filter(
        (predicate) =>
          JSON.stringify(compile({ ...BASE, ...PREDICATE_VALUES[predicate] })) === baseline,
      )
      expect([...dropped].sort()).toEqual([...(provider.ignoredIntakePredicates ?? [])].sort())
    })
  }

  it('covers every predicate the query vocabulary carries', () => {
    // Pinned against the port's own union rather than a count: a fifth predicate that no source
    // probes would otherwise be un-guarded on all four of them at once, and silently.
    const probed: Record<IssueIntakePredicate, true> = {
      titleFragment: true,
      labels: true,
      issueType: true,
      unassignedOnly: true,
    }
    expect(PREDICATES.sort()).toEqual(Object.keys(probed).sort())
  })
})
