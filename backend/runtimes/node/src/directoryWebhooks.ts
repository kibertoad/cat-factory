import {
  DIRECTORY_WEBHOOK_SWEEP_INTERVAL_MS,
  type Logger,
  type ServerContainer,
  type SweepHealthTracker,
  sweepDirectoryWebhooks,
} from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// The directory webhook delivery sweep for the Node facade: the analogue of the Worker's frequent
// cron call to the same shared `sweepDirectoryWebhooks`. A no-op returning a no-op stop when the
// facade wired no webhook support (no `ENCRYPTION_KEY`).

export function startDirectoryWebhookSweeper(
  container: ServerContainer,
  log: Logger,
  health: SweepHealthTracker,
): () => void {
  if (!container.directoryWebhooks) return () => {}
  return startSweeper({
    name: 'directory-webhooks',
    intervalMs: DIRECTORY_WEBHOOK_SWEEP_INTERVAL_MS,
    log,
    health,
    failureMessage: 'directory webhook sweep failed',
    tick: async () => {
      await sweepDirectoryWebhooks(container, log)
    },
  })
}
