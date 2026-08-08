import {
  decodeNotificationRoutingMatrix,
  isNotificationRouted,
  type NotificationRoutingMatrix,
} from '@cat-factory/contracts'
import type { NotificationSettingsRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the notification manager's store. Both facades gate their routed
// channels (in-app, email) on what this row decodes to, so a repository that upserts instead of
// replacing, or loses the JSON round trip, would mute a type on one runtime and mail it on the
// other — with nothing failing until somebody notices their inbox.
//
// The assertions deliberately run the DECODED matrix back through `isNotificationRouted`, the
// same function the delivery path and the settings UI use: what has to match across runtimes is
// the routing decision, not the byte-level shape of the column.

export function defineNotificationSettingsSuite(
  name: string,
  makeRepo: () => NotificationSettingsRepository,
): void {
  describe(`[${name}] notification settings repository parity`, () => {
    let seq = 0
    const wsId = () => {
      seq += 1
      return `ws-ntfset-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    const load = async (
      repo: NotificationSettingsRepository,
      workspaceId: string,
    ): Promise<NotificationRoutingMatrix | null> => {
      const record = await repo.getByWorkspace(workspaceId)
      return record ? decodeNotificationRoutingMatrix(JSON.parse(record.matrixJson)) : null
    }

    it('has no row until a workspace configures routing, so every type is on its default', async () => {
      const repo = makeRepo()
      const ws = wsId()

      expect(await repo.getByWorkspace(ws)).toBeNull()
      // The unconfigured reading: high impact reaches email, an everyday review park does not.
      expect(isNotificationRouted(null, 'merge_review', 'email')).toBe(true)
      expect(isNotificationRouted(null, 'requirement_review', 'email')).toBe(false)
      expect(isNotificationRouted(null, 'requirement_review', 'in_app')).toBe(true)
    })

    it('round-trips the overrides a workspace saved', async () => {
      const repo = makeRepo()
      const ws = wsId()
      const matrix: NotificationRoutingMatrix = {
        requirement_review: { email: true },
        merge_review: { email: false, in_app: false },
      }

      await repo.upsert({ workspaceId: ws, matrixJson: JSON.stringify(matrix), updatedAt: 1_000 })

      const stored = await repo.getByWorkspace(ws)
      expect(stored?.updatedAt).toBe(1_000)
      const decoded = await load(repo, ws)
      expect(isNotificationRouted(decoded, 'requirement_review', 'email')).toBe(true)
      expect(isNotificationRouted(decoded, 'merge_review', 'email')).toBe(false)
      expect(isNotificationRouted(decoded, 'merge_review', 'in_app')).toBe(false)
      // A type the workspace never touched still reads its shipped default.
      expect(isNotificationRouted(decoded, 'ci_failed', 'email')).toBe(true)
    })

    it('REPLACES the matrix on a second write rather than merging into it', async () => {
      const repo = makeRepo()
      const ws = wsId()
      await repo.upsert({
        workspaceId: ws,
        matrixJson: JSON.stringify({ merge_review: { email: false } }),
        updatedAt: 1_000,
      })

      await repo.upsert({
        workspaceId: ws,
        matrixJson: JSON.stringify({ ci_failed: { email: false } }),
        updatedAt: 2_000,
      })

      // Turning a cell back to its default is expressed by DROPPING the override, so a merging
      // write would make "undo my mute" unexpressible — on one runtime only, if the dialects
      // diverged here.
      const decoded = await load(repo, ws)
      expect(isNotificationRouted(decoded, 'merge_review', 'email')).toBe(true)
      expect(isNotificationRouted(decoded, 'ci_failed', 'email')).toBe(false)
      expect((await repo.getByWorkspace(ws))?.updatedAt).toBe(2_000)
    })

    it("keeps one board's routing out of another's", async () => {
      const repo = makeRepo()
      const muted = wsId()
      const other = wsId()
      await repo.upsert({
        workspaceId: muted,
        matrixJson: JSON.stringify({ merge_review: { email: false } }),
        updatedAt: 1_000,
      })

      expect(await repo.getByWorkspace(other)).toBeNull()
      expect(isNotificationRouted(await load(repo, other), 'merge_review', 'email')).toBe(true)
    })
  })
}
