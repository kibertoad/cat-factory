import type { SandboxPromptVersion } from '@cat-factory/kernel'

// Pure version-lineage logic for stored prompt candidates. A lineage starts when a
// baseline is cloned (version 1) and grows by append-only edits (each save is a new
// immutable version). `lineageId` is the v1's id, so all versions of one prompt share
// it; `version` is monotonic within the lineage. Mirrors the product's existing
// "edit a prompt ⇒ bump its number" convention (see agents' `versions.ts`).

export interface NewVersionFields {
  /** The id to assign the new version row. */
  id: string
  createdAt: number
  createdBy: string | null
  labels?: string[]
}

/** Clone a baseline (or any version's text) into a fresh candidate lineage at version 1. */
export function firstVersionFromBaseline(
  source: Pick<SandboxPromptVersion, 'agentKind' | 'systemText' | 'basePromptId'>,
  name: string,
  fields: NewVersionFields,
): SandboxPromptVersion {
  return {
    id: fields.id,
    lineageId: fields.id, // v1 roots its own lineage
    agentKind: source.agentKind,
    name,
    origin: 'candidate',
    systemText: source.systemText,
    basePromptId: source.basePromptId,
    version: 1,
    parentId: null,
    labels: fields.labels ?? [],
    createdAt: fields.createdAt,
    createdBy: fields.createdBy,
    archivedAt: null,
  }
}

/** Append a new version onto an existing lineage from an edited system prompt. */
export function nextVersion(
  parent: SandboxPromptVersion,
  systemText: string,
  fields: NewVersionFields,
): SandboxPromptVersion {
  return {
    id: fields.id,
    lineageId: parent.lineageId,
    agentKind: parent.agentKind,
    name: parent.name,
    origin: 'candidate',
    systemText,
    basePromptId: parent.basePromptId,
    version: parent.version + 1,
    parentId: parent.id,
    labels: fields.labels ?? [],
    createdAt: fields.createdAt,
    createdBy: fields.createdBy,
    archivedAt: null,
  }
}

/** The canonical `name@vN` label for a stored version (frozen onto each run). */
export function versionLabel(version: SandboxPromptVersion): string {
  return `${version.name}@v${version.version}`
}

/** Filter versions to those carrying every one of the given labels (AND semantics). */
export function filterByLabels(
  versions: SandboxPromptVersion[],
  labels: string[],
): SandboxPromptVersion[] {
  if (labels.length === 0) return versions
  const wanted = labels.map((l) => l.trim().toLowerCase()).filter(Boolean)
  return versions.filter((vsn) => {
    const have = new Set(vsn.labels.map((l) => l.toLowerCase()))
    return wanted.every((w) => have.has(w))
  })
}
