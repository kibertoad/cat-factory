import type {
  BlockRepository,
  DocQualityProvider,
  DocQualityReport,
  DocumentRepository,
  GitHubClient,
  RepoFiles,
} from '@cat-factory/kernel'
import { analyzeDocStructure, resolveDocLinkPath } from '@cat-factory/kernel'
import {
  requiredSectionTitles,
  resolveDocTemplate,
  resolveDocumentTarget,
} from '@cat-factory/agents'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'
import { makeRepoFiles } from '../agents/repoFiles.js'

export interface GitHubDocQualityProviderDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's document targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's document fields (kind + target path) and its PR ref. */
  blockRepository: BlockRepository
  /**
   * Optional: the document projections store. When wired, the gate resolves the workspace's
   * linked TEMPLATE for the block's kind (WS1) and checks against ITS sections — the same
   * override the doc-authoring prompts followed, so the writer and the gate never disagree.
   * Absent (or no template linked) ⇒ the built-in `docTemplateFor(kind)` skeleton.
   */
  documentRepository?: DocumentRepository
}

/**
 * The `doc-quality` gate's data source: a DETERMINISTIC structural check of a drafted
 * document on its PR head, read CHECKOUT-FREE via the `RepoFiles` port (so it is
 * runtime-symmetric across the Worker and Node — no container spun up for an instant check).
 *
 * It resolves the block's document kind + target path exactly as the doc-writer did
 * (`resolveDocumentTarget`, the shared path logic), reads the file at the PR head, and
 * classifies it with `analyzeDocStructure` against the kind's REQUIRED sections — resolved
 * through `docTemplateFor`/`requiredSectionTitles`, the WS1 template that is the single source
 * of truth for a kind's shape (the gate never keeps its own section list). In-repo relative
 * links are verified with one extra read each (distinct files, run concurrently — not a
 * repository-layer N+1).
 *
 * Returns a passing report (nothing to gate) when there is no resolvable PR/branch, so a
 * pipeline whose doc was never opened as a PR simply advances.
 */
export class GitHubDocQualityProvider implements DocQualityProvider {
  constructor(private readonly deps: GitHubDocQualityProviderDependencies) {}

  async check(workspaceId: string, blockId: string): Promise<DocQualityReport> {
    const pass = (headSha: string | null = null): DocQualityReport => ({
      ok: true,
      headSha,
      findings: [],
    })

    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block) return pass()
    const branch = block.pullRequest?.branch
    if (!branch) return pass() // no open PR/branch to gate

    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) return pass()

    const { docKind, targetPath } = resolveDocumentTarget(block)
    const repo: RepoFiles = makeRepoFiles(this.deps.githubClient, target.installationId, {
      owner: target.owner,
      repo: target.name,
    })
    const headSha = (await repo.headSha(branch)) ?? branch

    const file = await repo.getFile(targetPath, headSha)
    if (!file) {
      return {
        ok: false,
        headSha: typeof headSha === 'string' ? headSha : null,
        path: targetPath,
        findings: [`The document was not found at \`${targetPath}\` on the PR branch.`],
      }
    }

    // Resolve the kind's effective template through the SAME seam the prompts use: prefer the
    // workspace's linked `role: 'template'` document's parsed sections, else the built-in skeleton.
    const linkedTemplate = await this.deps.documentRepository?.getRoleLink(
      workspaceId,
      'template',
      docKind,
    )
    const analysis = analyzeDocStructure({
      content: file.content,
      requiredSections: requiredSectionTitles(resolveDocTemplate(docKind, linkedTemplate?.body)),
    })

    const findings: string[] = [
      ...analysis.missingSections.map((s) => `Missing required section: "${s}".`),
      ...analysis.placeholders.map((p) => `Leftover placeholder marker found: ${p}.`),
      ...analysis.headingIssues,
    ]

    // Verify each in-repo relative link resolves to a real file OR directory at the PR head.
    // Distinct paths with no batch API, so the reads run concurrently — not a repository
    // point-read loop. A directory target (`[examples](./examples/)`) has no file bytes, so
    // fall back to a directory listing before calling it broken.
    const broken = (
      await Promise.all(
        analysis.relativeLinks.map(async (link) => {
          const resolved = resolveDocLinkPath(targetPath, link)
          if (resolved === null) return null
          if (await repo.getFile(resolved, headSha)) return null
          const entries = await repo.listDirectory(resolved, headSha)
          return entries.length > 0
            ? null
            : `In-repo link "${link}" does not resolve (no file or directory at \`${resolved}\`).`
        }),
      )
    ).filter((f): f is string => f !== null)
    findings.push(...broken)

    return {
      ok: findings.length === 0,
      headSha: typeof headSha === 'string' ? headSha : null,
      path: targetPath,
      findings,
    }
  }
}
