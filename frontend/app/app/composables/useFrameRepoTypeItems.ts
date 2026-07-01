import { FRAME_REPO_TYPES } from '@cat-factory/contracts'
import type { FrameRepoType } from '~/types/domain'
import { BLOCK_TYPE_META } from '~/utils/catalog'

// One static, typed message key per onboardable repo role. The exhaustive Record means adding
// a FrameRepoType fails typecheck until it has a label here (the tier-2 dynamic-lookup guard),
// and keeping the keys as literals lets the i18n drift check see them.
const REPO_TYPE_LABEL_KEYS: Record<FrameRepoType, string> = {
  service: 'board.repoTypes.service',
  frontend: 'board.repoTypes.frontend',
  library: 'board.repoTypes.library',
  document: 'board.repoTypes.document',
}

/**
 * The repository-type options for the import + bootstrap selectors: one entry per
 * FRAME_REPO_TYPES role (i18n label + the shared block-type icon). Shared so
 * AddServiceFromRepoModal and BootstrapModal offer exactly the same set and can't drift.
 */
export function useFrameRepoTypeItems() {
  const { t } = useI18n()
  return computed(() =>
    FRAME_REPO_TYPES.map((value) => ({
      value,
      label: t(REPO_TYPE_LABEL_KEYS[value]),
      icon: BLOCK_TYPE_META[value].icon,
    })),
  )
}
