import type { GuidedReviewExplorer, GuidedReviewFileRequest } from '@cat-factory/agents'
import type { GitHubChangedFile, RepoFiles } from '@cat-factory/kernel'
import { getErrorMessage, redactSecrets } from '@cat-factory/kernel'

/** How much one job may read, and how much one read may return. */
export interface PrExplorerLimits {
  /** Tool reads per job; past it every tool says the budget is spent. */
  maxReads: number
  /** Lines one `read_file` returns before it truncates and says where to resume. */
  maxFileLines: number
  /** Characters one answer returns before it truncates. */
  maxChars: number
}

export const DEFAULT_PR_EXPLORER_LIMITS: PrExplorerLimits = {
  maxReads: 40,
  maxFileLines: 400,
  maxChars: 40_000,
}

export interface PrExplorerTarget {
  headSha: string
  baseRef: string
}

/**
 * Reads one pull request for a guided-review model call, pinned to the reviewed head. Every
 * answer is text the model reads directly: the content, or the sentence saying why there is
 * none, so an unreadable file is a stated fact rather than an aborted generation. Content is
 * scrubbed of secrets before the model sees it, since answers are stored and shown.
 */
export class PrExplorer implements GuidedReviewExplorer {
  private reads = 0
  private readonly byPath: Map<string, GitHubChangedFile>

  constructor(
    private readonly repo: RepoFiles,
    private readonly target: PrExplorerTarget,
    private readonly files: GitHubChangedFile[],
    private readonly limits: PrExplorerLimits = DEFAULT_PR_EXPLORER_LIMITS,
  ) {
    this.byPath = new Map(files.map((f) => [f.path, f]))
  }

  /** Reads this job has spent, for the caller's telemetry. */
  get readsUsed(): number {
    return this.reads
  }

  async listChangedFiles(): Promise<string> {
    return this.charge(async () => {
      if (this.files.length === 0) return 'The pull request changes no files.'
      return this.files
        .map((f) => {
          const stats =
            f.additions === null && f.deletions === null
              ? ''
              : ` (+${f.additions ?? '?'} -${f.deletions ?? '?'})`
          const from = f.previousPath && f.previousPath !== f.path ? ` from ${f.previousPath}` : ''
          return `${f.status} ${f.path}${from}${stats}`
        })
        .join('\n')
    })
  }

  async readDiff(path: string): Promise<string> {
    return this.charge(async () => {
      const file = this.byPath.get(normalizePath(path))
      if (!file) return `\`${path}\` is not a file this pull request changes.`
      if (file.patch === null) {
        return (
          `The host returned no patch for \`${path}\` (a binary file, or a diff too large to ` +
          'inline). Read the file itself with `read_file` on each side instead.'
        )
      }
      return this.bound(scrub(file.patch), `the patch of \`${path}\``)
    })
  }

  async readFile(request: GuidedReviewFileRequest): Promise<string> {
    return this.charge(async () => {
      const path = normalizePath(request.path)
      const ref = request.side === 'base' ? this.target.baseRef : this.target.headSha
      const where = request.side === 'base' ? `the target branch \`${ref}\`` : 'the PR head'
      let file
      try {
        file = await this.repo.getFile(path, ref)
      } catch (error) {
        return `Reading \`${path}\` on ${where} failed: ${getErrorMessage(error)}`
      }
      if (!file) return `There is no file \`${path}\` on ${where}.`
      if (file.lossy) return `\`${path}\` is not a text file, so it cannot be shown.`
      return this.renderLines(path, scrub(file.content), request.startLine, request.endLine)
    })
  }

  async listDirectory(path: string): Promise<string> {
    return this.charge(async () => {
      const dir = normalizePath(path)
      let entries
      try {
        entries = await this.repo.listDirectory(dir, this.target.headSha)
      } catch (error) {
        return `Listing \`${dir || '.'}\` failed: ${getErrorMessage(error)}`
      }
      if (entries.length === 0)
        return `\`${dir || '.'}\` is empty or does not exist at the PR head.`
      const lines = entries.map((e) => `${e.type === 'dir' ? 'dir ' : 'file'} ${e.path}`)
      return this.bound(lines.join('\n'), `the listing of \`${dir || '.'}\``)
    })
  }

  private async charge(read: () => Promise<string>): Promise<string> {
    if (this.reads >= this.limits.maxReads) {
      return (
        `The read budget for this reply is spent (${this.limits.maxReads} reads). Answer from ` +
        'what you have read, and say what you could not check.'
      )
    }
    this.reads += 1
    return read()
  }

  private renderLines(
    path: string,
    content: string,
    startLine: number | undefined,
    endLine: number | undefined,
  ): string {
    const lines = content.split('\n')
    const first = Math.min(Math.max(startLine ?? 1, 1), Math.max(lines.length, 1))
    const requestedLast = Math.min(endLine ?? lines.length, lines.length)
    const last = Math.min(requestedLast, first + this.limits.maxFileLines - 1)
    const numbered = lines
      .slice(first - 1, last)
      .map((line, i) => `${first + i}: ${line}`)
      .join('\n')
    const header = `\`${path}\` lines ${first}-${last} of ${lines.length}`
    const rest =
      last < requestedLast
        ? `\n(Truncated at ${this.limits.maxFileLines} lines; read from line ${last + 1} for more.)`
        : ''
    return this.bound(`${header}\n${numbered}${rest}`, header)
  }

  private bound(text: string, what: string): string {
    if (text.length <= this.limits.maxChars) return text
    return (
      `${text.slice(0, this.limits.maxChars)}\n(${what} was cut at ${this.limits.maxChars} ` +
      `characters; ${text.length - this.limits.maxChars} more were not shown. Read a narrower range.)`
    )
  }
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\.?\/+/, '')
}

function scrub(text: string): string {
  return redactSecrets(text) ?? ''
}
