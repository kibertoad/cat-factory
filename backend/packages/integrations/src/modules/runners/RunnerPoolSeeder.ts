import { registerRunnerPoolSchema, type RegisterRunnerPoolInput } from '@cat-factory/contracts'
import {
  describeError,
  type AccountRecord,
  type AccountRepository,
  type AccountRunnerPoolRepository,
  type Logger,
  type RunnerPoolSeeder,
} from '@cat-factory/kernel'
import * as v from 'valibot'
import type { RunnerPoolConnectionService } from './RunnerPoolConnectionService.js'

// The generic, deployment-neutral implementation of the kernel {@link RunnerPoolSeeder} port, and
// the runner-pool sibling of `createEnvironmentHandlerSeeder`: same two wiring sites (a boot
// backfill, and `WorkspaceService.create`'s on-create hook), but keyed by ACCOUNT, the scope a pool
// is inherited at. It carries NO deployment knowledge: a deployment supplies the seed through a
// callback on its composition root.

/**
 * A deployment's declared runner pool for one account: the same `{ config, secrets }` an admin
 * submits through Infrastructure → Runner pool.
 */
export type RunnerPoolSeed = RegisterRunnerPoolInput

/**
 * How a deployment declares its pools: given an account, the pool it should have, or `undefined`
 * for none. Called for personal and org accounts alike. It runs only for an account that has no
 * pool yet, and may be async (a deployment can look the answer up).
 */
export type RunnerPoolSeedSource = (
  account: AccountRecord,
) => RunnerPoolSeed | undefined | Promise<RunnerPoolSeed | undefined>

/**
 * Build the deployment-neutral {@link RunnerPoolSeeder}. An account that already has a pool is
 * never touched, so an earlier seed stands and a second boot is a no-op.
 *
 * Two kinds of failure, treated differently on purpose:
 * - a READ failing (the pool or account store) is logged at `warn` and swallowed, because neither
 *   board creation nor boot may fail on it, and the next boot retries;
 * - a BAD SEED (the callback throws, its output is not a runner pool, or the backend refuses it)
 *   is logged at `error` naming the account and the reason, and never skipped quietly: a
 *   deployment whose declared pool is wrong must hear about it on every boot, not discover it
 *   when a board has nowhere to run.
 */
export function createRunnerPoolSeeder(deps: {
  connectionService: Pick<RunnerPoolConnectionService, 'seedAccount'>
  accountRepository: Pick<AccountRepository, 'get' | 'listAll'>
  accountRunnerPoolRepository: Pick<AccountRunnerPoolRepository, 'getByAccount' | 'listByAccounts'>
  seedSource: RunnerPoolSeedSource
  logger?: Logger
}): RunnerPoolSeeder {
  const { connectionService, accountRepository, accountRunnerPoolRepository, seedSource, logger } =
    deps

  async function seedOne(account: AccountRecord): Promise<void> {
    try {
      const declared = await seedSource(account)
      if (declared === undefined) return
      const parsed = v.safeParse(registerRunnerPoolSchema, declared)
      if (!parsed.success) {
        logger?.error('declared runner pool is not a valid runner pool', {
          accountId: account.id,
          issues: parsed.issues.map((issue) => issue.message),
        })
        return
      }
      if (await connectionService.seedAccount(account.id, parsed.output)) {
        logger?.info('seeded account runner pool', {
          accountId: account.id,
          kind: parsed.output.config.kind,
        })
      }
    } catch (error) {
      logger?.error('declared runner pool was refused for account', {
        accountId: account.id,
        ...describeError(error),
      })
    }
  }

  return {
    async ensureForAccount(accountId) {
      if (accountId === null) return
      try {
        if (await accountRunnerPoolRepository.getByAccount(accountId)) return
        const account = await accountRepository.get(accountId)
        if (account) await seedOne(account)
      } catch (error) {
        logger?.warn('could not read account state to seed its runner pool', {
          accountId,
          ...describeError(error),
        })
      }
    },

    async ensureForAllAccounts() {
      try {
        const accounts = await accountRepository.listAll()
        const seeded = new Set(
          (await accountRunnerPoolRepository.listByAccounts(accounts.map((a) => a.id))).map(
            (row) => row.accountId,
          ),
        )
        for (const account of accounts) {
          if (!seeded.has(account.id)) await seedOne(account)
        }
      } catch (error) {
        logger?.warn('could not enumerate accounts to seed runner pools', describeError(error))
      }
    },
  }
}
