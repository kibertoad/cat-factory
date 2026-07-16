// ---------------------------------------------------------------------------
// Persistence ports for the repo-sourced Claude Skills library
// (docs/initiatives/repo-skills.md). A team authors skills in a repo — a
// directory (conventionally `.claude/skills/<skill>/`) containing a `SKILL.md`
// (YAML frontmatter `name`/`description` + a markdown body of procedural
// instructions) plus optional sibling resource files. A `skill_sources` link
// (repo + dir) is synced into `account_skills` rows, mirroring the repo-sourced
// prompt-fragment machinery (ADR 0006) but with two differences: skills live in
// ONE tier (the account, shared across its workspaces — not the account/workspace
// pair fragments use) and the sync unit is a DIRECTORY (`<skill>/SKILL.md` + its
// siblings), not a single Markdown file.
// ---------------------------------------------------------------------------

/**
 * One sibling resource file of a skill (a template/script/checklist). The manifest
 * stores `{ path, sha, size }` only — the body is fetched at the skill's pinned
 * commit at dispatch (slice 2), never persisted here, so a linked source can't
 * bloat our storage with large resources.
 */
export interface SkillResource {
  /** Path relative to the repo root, e.g. `.claude/skills/triage/templates/report.md`. */
  path: string
  /** Blob sha at the pinned commit — powers the cheap resource-changed check. */
  sha: string
  /** Byte size from the tree listing (used to bound what a run materialises). */
  size: number
}

/**
 * A persisted skill row at the account tier (see the initiative tracker). Owned by
 * an account so every workspace in the account shares one skill catalog; carries a
 * tombstone (`deletedAt`) so a renamed/removed skill retires cleanly.
 */
export interface AccountSkillRecord {
  /** Stable, globally-unique id — always `src:<sourceId>:<dirName>` (repo-sourced). */
  skillId: string
  accountId: string
  /** Skill name from `SKILL.md` frontmatter (the native CLI skill directory name). */
  name: string
  /** One-line description from frontmatter; feeds the palette/picker (slice 3). */
  description: string
  /** The `SKILL.md` markdown body — the procedural instructions the agent follows. */
  instructions: string
  /** Sibling resource files (manifest only; bodies fetched at dispatch, slice 2). */
  resources: SkillResource[]
  /** Provenance: the {@link SkillSourceRecord} that produced this skill. */
  sourceId: string
  /** The `SKILL.md` path within the source repo. */
  sourcePath: string
  /** `SKILL.md` blob sha last synced; powers the file-changed check. */
  sourceSha: string
  /**
   * Head commit the skill's directory was pinned to at the last sync. The basis for
   * per-run version pinning (slice 2) and the resource-only-change re-list (a resource
   * edit advances the dir head without touching `SKILL.md`'s blob sha). Null before
   * the first successful sync.
   */
  pinnedCommit: string | null
  createdAt: number
  updatedAt: number
  /** Tombstone: the skill was removed upstream or its source was unlinked. */
  deletedAt: number | null
}

export interface AccountSkillRepository {
  /**
   * Skills owned by an account. Excludes tombstones by default; pass `includeDeleted`
   * for the catalog resolve (which must see nothing extra today, but keeps parity with
   * the fragment repo and lets a later merge honour suppressions).
   */
  listByAccount(accountId: string, includeDeleted?: boolean): Promise<AccountSkillRecord[]>
  get(accountId: string, skillId: string): Promise<AccountSkillRecord | null>
  upsert(record: AccountSkillRecord): Promise<void>
  softDelete(accountId: string, skillId: string, at: number): Promise<void>
  /**
   * Tombstone EVERY live skill produced by a source in one write (used on unlink), so
   * retiring a source's catalog isn't a point-write per skill.
   */
  softDeleteBySource(sourceId: string, at: number): Promise<void>
  /** Live skills produced by a given source, for resync diffing/tombstoning. */
  listBySource(sourceId: string): Promise<AccountSkillRecord[]>
}

/**
 * A repo directory an account links as a source of Claude skill directories
 * (the initiative tracker's `skill_sources`). Reads go through the account's
 * existing GitHub installation — no new credential store, exactly like fragment
 * sources.
 */
export interface SkillSourceRecord {
  id: string
  accountId: string
  repoOwner: string
  repoName: string
  gitRef: string
  /** Subtree to scan for `<skill>/SKILL.md` directories (e.g. `.claude/skills`). */
  dirPath: string
  /**
   * Sha of the most recent commit that touched the source directory at the last
   * successful sync; powers the lightweight "changed?" check (compare against the
   * repo's current head commit for the dir). Null before the first sync.
   */
  lastSyncedCommit: string | null
  lastSyncedAt: number | null
  createdAt: number
  deletedAt: number | null
}

export interface SkillSourceRepository {
  listByAccount(accountId: string): Promise<SkillSourceRecord[]>
  get(id: string): Promise<SkillSourceRecord | null>
  upsert(record: SkillSourceRecord): Promise<void>
  updateSyncState(id: string, lastSyncedCommit: string | null, lastSyncedAt: number): Promise<void>
  softDelete(id: string, at: number): Promise<void>
}
