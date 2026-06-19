// Moved to the shared, runtime-neutral @cat-factory/server package. Re-exported
// here so existing `../observability/logger` imports keep resolving.
export { logger } from '@cat-factory/server'
export type { Logger } from '@cat-factory/server'
