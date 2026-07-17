import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AccountSkill,
  LinkSkillSourceInput,
  SkillSource,
  SkillSyncResult,
} from '~/types/domain'
import { useSingleFlightProbe } from '~/composables/useSingleFlightProbe'
import { useSkillsStore } from '~/stores/skills'

/**
 * The repo-sourced Claude Skills library for one account (docs/initiatives/repo-skills.md),
 * used by the account-settings management surface. Holds the account's synced skill catalog
 * (full detail) and its linked repo sources, and drives link / sync / status / unlink. Skills
 * are a single account tier (no workspace tier), so — unlike the fragment library — there is no
 * owner-kind axis; the store is keyed purely by account id.
 *
 * `available` mirrors the backend's opt-in gate: a 503 from the catalog probe means the feature
 * is off and the UI hides its panel. `sourcesAvailable` is the finer gate — the catalog read
 * works, but linking/syncing repo sources needs the GitHub integration, whose absence 503s only
 * the `skill-sources/*` routes.
 *
 * After any mutation that changes the catalog, the updated summaries are pushed into the
 * snapshot-hydrated {@link useSkillsStore} so the pipeline builder's picker reflects the change
 * immediately, without a full board refresh.
 */
function skillLibrarySetup(resolveAccountId: () => string | null) {
  const api = useApi()

  /** null = not probed yet; true/false = library on/off (the catalog read). */
  const available = ref<boolean | null>(null)
  /** false when the GitHub integration is off (catalog works; source linking/syncing does not). */
  const sourcesAvailable = ref(true)
  /** The account's synced skills (full detail — instructions + resource manifest). */
  const catalog = ref<AccountSkill[]>([])
  /** Linked repo sources of skill folders. */
  const sources = ref<SkillSource[]>([])
  /** Per-source "changes available" flag from the last status check. */
  const sourceChanges = ref<Record<string, boolean>>({})
  const loading = ref(false)

  function requireAccountId(): string {
    const id = resolveAccountId()
    if (!id) throw new Error('No skill-library account')
    return id
  }

  /** Mirror the full catalog into the snapshot picker store as lightweight summaries. */
  function syncPicker() {
    useSkillsStore().hydrate(
      catalog.value.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    )
  }

  /** Probe the feature + load this account's catalog and sources. */
  async function runProbe() {
    const id = resolveAccountId()
    if (!id) return
    try {
      catalog.value = await api.listAccountSkills(id)
      available.value = true
      syncPicker()
    } catch {
      available.value = false
      catalog.value = []
      sources.value = []
      return
    }
    // Sources need the GitHub integration; a 503 here just hides the linking UI (the catalog
    // read above already succeeded, so the feature itself is on).
    try {
      sources.value = await api.listSkillSources(id)
      sourcesAvailable.value = true
    } catch {
      sources.value = []
      sourcesAvailable.value = false
    }
  }
  // Single-flight the probe keyed on the account id, so the panel-open fan-out loads once.
  const { probe, ensureProbed } = useSingleFlightProbe(runProbe, () => resolveAccountId())

  async function reloadCatalog() {
    catalog.value = await api.listAccountSkills(requireAccountId())
    syncPicker()
  }

  async function reloadSources() {
    sources.value = await api.listSkillSources(requireAccountId())
  }

  async function linkSource(input: LinkSkillSourceInput): Promise<SkillSource> {
    const source = await api.linkSkillSource(requireAccountId(), input)
    sources.value = [source, ...sources.value]
    // Auto-sync the freshly-linked source so its skills land in the catalog immediately.
    await syncSourceRaw(source.id)
    return source
  }

  async function unlinkSource(sourceId: string) {
    await api.unlinkSkillSource(requireAccountId(), sourceId)
    sources.value = sources.value.filter((s) => s.id !== sourceId)
    delete sourceChanges.value[sourceId]
    await reloadCatalog()
  }

  /** The bare sync used both by the row action and the auto-sync after link. */
  async function syncSourceRaw(sourceId: string): Promise<SkillSyncResult> {
    const result = await api.syncSkillSource(requireAccountId(), sourceId)
    delete sourceChanges.value[sourceId]
    await Promise.all([reloadSources(), reloadCatalog()])
    return result
  }

  async function syncSource(sourceId: string): Promise<SkillSyncResult> {
    loading.value = true
    try {
      return await syncSourceRaw(sourceId)
    } finally {
      loading.value = false
    }
  }

  /** Lightweight commit-version "check for changes" for a source; caches the flag. */
  async function checkSource(sourceId: string) {
    const status = await api.skillSourceStatus(requireAccountId(), sourceId)
    sourceChanges.value = { ...sourceChanges.value, [sourceId]: status.changed }
    return status
  }

  return {
    available,
    sourcesAvailable,
    catalog,
    sources,
    sourceChanges,
    loading,
    probe,
    ensureProbed,
    linkSource,
    unlinkSource,
    syncSource,
    checkSource,
  }
}

/**
 * An account-keyed skill-library store (one isolated instance per account), used by the
 * account-settings Skills tab.
 */
export function useSkillLibrary(accountId: string) {
  return defineStore(`skillLibrary:${accountId}`, () => skillLibrarySetup(() => accountId))()
}
