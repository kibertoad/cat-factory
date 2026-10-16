// Seeding a Pinia store for a story.
//
// No component under `panels/inspector/` calls the API itself: they read stores. So the layer
// between a props-only component story and a full scene is a decorator that puts plausible state
// into the stores a component reads. That is this file.
//
// Some panels call a store LOADER on mount (`ensureLoaded`, `load`, `loadBranches`, `loadRuns`).
// A seed for one of those must also leave the store in the state its loader treats as loaded, or
// the loader sends a request that no backend answers.
//
// Each story gets its OWN Nuxt app from the preset, so each gets its own Pinia and seeds cannot
// leak between stories. `storybook/preview-api`'s `useEffect` is not involved: the seed runs in
// the decorator's `setup`, which is before the wrapped component's own setup, so a computed that
// reads the store on first render already sees the data.
import { h } from 'vue'
import type { Decorator } from '@storybook/vue3'
import type {
  DocumentConnection,
  DocumentSourceDescriptor,
  DocumentSourceKind,
  FoundationalService,
  FoundationalServiceSource,
  FoundationalServiceSuppression,
  ModelOption,
  ResolvedFoundationalService,
  ServiceCatalogConnection,
  WorkspaceSnapshot,
} from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useDocumentsStore } from '~/stores/documents'
import {
  useFoundationalServices,
  useFoundationalServicesStore,
} from '~/stores/foundationalServices'
import { useGitHubStore } from '~/stores/github'
import { useLaneViewStore } from '~/stores/laneView'
import { useModelsStore } from '~/stores/models'
import { useServicesStore } from '~/stores/services'
import { useUiStore } from '~/stores/ui'
import { useUiModeStore } from '~/stores/uiMode'
import { useWorkspaceStore } from '~/stores/workspace'
import { applySnapshotToStores } from '~/stores/workspace/hydrate'
import type { LaneGroupKey } from '~/utils/laneSort'
import type { UiMode } from '~/utils/uiMode'
import { STORY_WORKSPACE_ID } from './workspace'
import { authRepo, authServiceRow, githubConnection } from './vcs.stories.mocks'

/**
 * Run `seed` in the story's own Nuxt app, before the component's setup. `story()` is called once,
 * outside the render function: each call builds a new component, and a new one per render
 * remounts the story (see the decorator in `.storybook/preview.ts`).
 */
export function withSeed(seed: () => void): Decorator {
  return (story) => {
    const Story = story()
    return {
      setup() {
        seed()
        return () => h(Story)
      },
    }
  }
}

/**
 * Put blocks on the board store. Every getter derives from them, and some read the story's OWN
 * block back from the store (`isRunnable`), so that block belongs in the list too.
 */
export function seedBoard(blocks: Block[]): void {
  useBoardStore().hydrate(blocks)
}

/** `seedBoard` as a decorator, for a story that seeds nothing else. */
export function withBoard(blocks: Block[]): Decorator {
  return withSeed(() => seedBoard(blocks))
}

/** Make the story workspace the active one, so a store's `requireId()` has an id to return. */
export function seedWorkspace(): void {
  useWorkspaceStore().workspaceId = STORY_WORKSPACE_ID
}

/** Pick the interface tier, as the user's switcher would. `preview.ts` clears it before each story. */
export function seedUiMode(mode: UiMode): void {
  useUiModeStore().setMode(mode)
}

/** Connect GitHub and link the shared board's services to their repos, as the snapshot would. */
export function seedVcs(): void {
  const github = useGitHubStore()
  github.connection = githubConnection
  github.repos = [authRepo]
  useServicesStore().hydrate([], [authServiceRow])
}

/**
 * Fill every store from one workspace snapshot, through the same fan-out the workspace store's
 * `hydrate` calls. Synchronous, so the component's first render already sees the data.
 */
export function seedSnapshot(next: WorkspaceSnapshot): void {
  useWorkspaceStore().workspaceId = next.workspace.id
  applySnapshotToStores(next)
}

/** `seedSnapshot` as a decorator, for a story that seeds nothing else. */
export function withSnapshot(next: WorkspaceSnapshot): Decorator {
  return withSeed(() => seedSnapshot(next))
}

type ResultView = NonNullable<ReturnType<typeof useUiStore>['resultView']>

/**
 * Open a result window. In the app a step's window opens through `ui.dispatchStepView`, which
 * picks the view from the step's agent kind in the catalog; a story names the view instead, so
 * it does not depend on a seeded catalog. (A window opened off the run path, such as the
 * brainstorm or the requirements review, also has its own `ui.open*` action.)
 *
 * Seed the run in the execution store too: the window finds its step there. A run seeded whole
 * (no `projected` mark, as `execution()` builds it) is not fetched again; a projected one makes
 * `ResultWindowShell` ask `getExecutionContract` for the whole run.
 */
export function seedResultView(view: ResultView): void {
  useUiStore().resultView = view
}

/**
 * Arrange the swimlanes: grouped by `groupKey`, in the default order, with the Done lane shut.
 * The browser keeps the lane view store, so a story that leaves it alone gets what the last story
 * set.
 */
export function seedLaneView(groupKey: LaneGroupKey = 'none'): void {
  const laneView = useLaneViewStore()
  laneView.reset()
  laneView.setGroupKey(groupKey)
  laneView.doneLaneCollapsed = true
}

/**
 * Make the viewer a board viewer: read-only, so every write and run control disables. The
 * permissions are the backend's for the role (`WORKSPACE_ROLE_PERMISSIONS` in kernel). With no
 * access seeded the SPA allows everything, as it does before the snapshot arrives.
 */
export function seedViewer(): void {
  useWorkspaceStore().access = { role: 'viewer', permissions: ['workspace.read'] }
}

/**
 * Make the viewer a board member: they edit the board and run tasks, and may not change its
 * settings, integrations, secrets or roster. The permissions are the backend's for the role.
 */
export function seedMember(): void {
  useWorkspaceStore().access = {
    role: 'member',
    permissions: ['workspace.read', 'board.write', 'runs.execute'],
  }
}

/**
 * The document sources the deployment offers, the ones the workspace connected and the ones it
 * can connect through OAuth, as the documents store's probe reads them. Marks the integration
 * available, so the surfaces that hide behind the probe render.
 */
export function seedDocumentSources(
  sources: DocumentSourceDescriptor[],
  connections: DocumentConnection[],
  oauthSources: DocumentSourceKind[] = [],
): void {
  const documents = useDocumentsStore()
  documents.available = true
  documents.sources = sources
  documents.connections = connections
  documents.oauthSources = oauthSources
}

/**
 * The story workspace's model catalog, marked loaded for it, so `useAiReadiness` reports ready
 * and the AI prompts judge this catalog. Makes the story workspace the active one.
 */
export function seedModelCatalog(catalog: ModelOption[]): void {
  seedWorkspace()
  const models = useModelsStore()
  models.models = catalog
  models.loaded = true
  models.loadedWorkspaceId = STORY_WORKSPACE_ID
}

/** What a foundational-services store holds once its probe has answered. */
export interface FoundationalCatalogSeed {
  services?: FoundationalService[]
  resolved?: ResolvedFoundationalService[]
  suppressions?: FoundationalServiceSuppression[]
  sources?: FoundationalServiceSource[]
  sourcesAvailable?: boolean
  sourceChanges?: Record<string, boolean>
  serviceCatalog?: ServiceCatalogConnection | null
  serviceCatalogAvailable?: boolean
}

/**
 * Fill the foundational-services catalog as its probe would, for a section that reads the store
 * and does not probe itself (the manager around them does). The story board's catalog by default;
 * pass the account to fill that account's own store instead.
 */
export function seedFoundationalCatalog(
  seed: FoundationalCatalogSeed,
  accountId: string | null = null,
): void {
  seedWorkspace()
  const store = accountId
    ? useFoundationalServices('account', accountId)
    : useFoundationalServicesStore()
  store.$patch({ available: true, ...seed })
}
