export {
  createAppCaches,
  DEFAULT_APP_CACHES_PROFILE,
  ISOLATE_COHERENT_APP_CACHES_PROFILE,
  ISOLATE_SAFE_APP_CACHES_PROFILE,
} from './appCaches.js'
export type {
  AppCachesProfile,
  CreateAppCachesOptions,
  GroupCacheNotifications,
  GroupCacheProfile,
  GroupNotificationPairFactory,
} from './appCaches.js'
export { CACHE_EPOCH_GROUP } from './generationCoherency.js'
export type { CacheGenerationStore } from './generationCoherency.js'
// Re-exported so a facade can type its background-work adopter without importing
// layered-loader directly (and without being tempted by the package ROOT, whose
// import would drag the Redis surface into the Worker's graph).
export type { BackgroundWorkMeta, BackgroundWorkScheduler } from 'layered-loader/core'
