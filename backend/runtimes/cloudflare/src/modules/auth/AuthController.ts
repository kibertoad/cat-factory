// Moved to the shared @cat-factory/server package (mounted via registerCoreControllers).
// Re-exported here so existing imports — notably the auth integration test's
// `pickPostLoginRedirect` unit check — keep resolving.
export { authController, pickPostLoginRedirect } from '@cat-factory/server'
