import type { Logger } from '@cat-factory/kernel'
import type { ServerContainer } from '../http/env.js'

// The directory webhook delivery sweep (docs/initiatives/directory-sync.md, slice 4), shared by
// the Worker's frequent cron and the Node timer so both facades push on the same terms. A no-op
// when the facade wired no webhook support (no `ENCRYPTION_KEY`).

/**
 * How often the sweep runs, so a change reaches a receiver within about this long. Two minutes
 * because that is the Worker's frequent cron tick; the Node timer runs on the same cadence.
 */
export const DIRECTORY_WEBHOOK_SWEEP_INTERVAL_MS = 2 * 60_000

export async function sweepDirectoryWebhooks(
  container: Pick<ServerContainer, 'directoryWebhooks'>,
  log: Logger,
): Promise<{ pushed: number; failed: number }> {
  const service = container.directoryWebhooks
  if (!service) return { pushed: 0, failed: 0 }
  const result = await service.deliverPending()
  if (result.pushed > 0 || result.failed > 0) log.info('directory webhook sweep', { ...result })
  return result
}
