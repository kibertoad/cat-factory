import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CreateProjectInput,
  PinnableProjectDefinition,
  Project,
  ProjectKindDescriptor,
  WorkspaceMount,
} from '@cat-factory/contracts'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Projects: account-owned peers of services. A project owns a root block (level `project`) whose
 * tasks sit directly beneath it, is mounted onto boards like a service, and links to services as
 * read-only context. Hydrated from the workspace snapshot: the account's `catalog`, this board's
 * project `mounts`, and the `kinds` the deployment registers.
 */
export const useProjectsStore = defineStore('projects', () => {
  const api = useApi()

  const catalog = ref<Project[]>([])
  const mounts = ref<WorkspaceMount[]>([])
  const kinds = ref<ProjectKindDescriptor[]>([])
  /** The kinds could not be read (a mothership-mode node whose mothership did not answer). */
  const kindsUnavailable = ref(false)

  function hydrate(snapshot: {
    projectCatalog?: Project[]
    mounts?: WorkspaceMount[]
    projectKinds?: ProjectKindDescriptor[]
    projectKindsUnavailable?: boolean
  }) {
    catalog.value = [...(snapshot.projectCatalog ?? [])]
    mounts.value = (snapshot.mounts ?? []).filter((m) => m.subjectKind === 'project')
    kinds.value = [...(snapshot.projectKinds ?? [])]
    kindsUnavailable.value = snapshot.projectKindsUnavailable === true
  }

  /** Catalog project keyed by its root block id. */
  const byRootBlock = computed<Record<string, Project>>(() => {
    const map: Record<string, Project> = {}
    for (const p of catalog.value) map[p.rootBlockId] = p
    return map
  })

  function kindOf(project: Project | undefined): ProjectKindDescriptor | undefined {
    return project ? kinds.value.find((k) => k.id === project.kind) : undefined
  }

  /** The account's projects not yet on this board. */
  const mountable = computed<Project[]>(() => {
    const mounted = new Set(mounts.value.map((m) => m.subjectId))
    return catalog.value.filter((p) => !mounted.has(p.id))
  })

  /** A project root is "shared" when its project is mounted on more than one board. */
  function isSharedRoot(rootBlockId: string): boolean {
    return (byRootBlock.value[rootBlockId]?.mountCount ?? 0) > 1
  }

  async function create(input: CreateProjectInput) {
    const ws = useWorkspaceStore()
    const created = await api.createProject(ws.requireId(), input)
    await ws.refresh()
    return created
  }

  /** The definition versions of `kind` this board's account can pin on a new project. */
  async function listPinnableDefinitions(kind: string): Promise<PinnableProjectDefinition[]> {
    const ws = useWorkspaceStore()
    return api.listPinnableProjectDefinitions(ws.requireId(), kind)
  }

  async function setServices(projectId: string, serviceIds: string[]) {
    const ws = useWorkspaceStore()
    const updated = await api.setProjectServices(ws.requireId(), projectId, serviceIds)
    catalog.value = catalog.value.map((p) => (p.id === updated.id ? { ...p, ...updated } : p))
    return updated
  }

  async function mount(projectId: string) {
    const ws = useWorkspaceStore()
    await api.mountProject(ws.requireId(), projectId)
    await ws.refresh()
  }

  async function unmount(projectId: string) {
    const ws = useWorkspaceStore()
    await api.unmountProject(ws.requireId(), projectId)
    await ws.refresh()
  }

  return {
    catalog,
    mounts,
    kinds,
    kindsUnavailable,
    byRootBlock,
    kindOf,
    mountable,
    isSharedRoot,
    hydrate,
    listPinnableDefinitions,
    create,
    setServices,
    mount,
    unmount,
  }
})
