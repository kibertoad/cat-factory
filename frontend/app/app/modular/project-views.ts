import { defineModule } from '@modular-vue/core'
import { RESEARCH_KIND } from '@cat-factory/contracts'
import type { ProjectViewContribution } from './slots'
import { defineAsyncView } from '~/utils/asyncView'

// Code-split like the result windows: a reader opens on a deliberate click, and most boards hold
// no project of the kind.
const ResearchFindingsView = defineAsyncView(
  () => import('~/components/research/ResearchFindingsView.vue'),
)

/**
 * The first-party project readers: the research kind's findings reader. A deployment shipping its
 * own kind contributes its reader to the same `projectViews` slot from a `registerAppModule`
 * module; a kind with none is read through the generic outcome reader. Registered from the client
 * plugin, since it carries Vue components.
 */
export const projectViewsModule = defineModule({
  id: 'cat-factory:project-views',
  version: '1.0.0',
  slots: {
    projectViews: [
      {
        id: RESEARCH_KIND,
        component: ResearchFindingsView,
        labelKey: 'research.tabs.findings',
        icon: 'i-lucide-telescope',
      },
    ] satisfies ProjectViewContribution[],
  },
})
