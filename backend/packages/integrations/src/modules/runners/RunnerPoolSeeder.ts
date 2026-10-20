import { registerRunnerPoolSchema, type RegisterRunnerPoolInput } from '@cat-factory/contracts'
import {
  describeError,
  type AccountRecord,
  type AccountRepository,
  type AccountRunnerPoolRecord,
  type AccountRunnerPoolRepository,
  type Logger,
  type RunnerPoolSeeder,
} from '@cat-factory/kernel'
import * as v from 'valibot'
import type { RunnerPoolConnectionService } from './RunnerPoolConnectionService.js'

/**
 * A deployment's declared runner pool for one account: the same `{ config, secrets }` an admin
 * submits through Infrastructure → Runner pool.
 */
export type RunnerPoolSeed = RegisterRunnerPoolInput

/**
 * How a deployment declares its pools: given an account, the pool it should have, or `undefined`
 * for none. Called for personal and org accounts alike, and may be async (a deployment can look the
 * answer up). The boot backfill calls it for EVERY account, so a changed answer replaces the pool
 * stored before; board creation calls it only for an account that has no pool yet. Answering
 * `undefined` for an account that already has a pool leaves that pool in place.
 */
export type RunnerPoolSeedSource = (
  account: AccountRecord,
) => RunnerPoolSeed | undefined | Promise<RunnerPoolSeed | undefined>

/**
 * Build the deployment-neutral {@link RunnerPoolSeeder}, the account-keyed sibling of
 * `createEnvironmentHandlerSeeder`. A deployment supplies the seed through a callback on its
 * composition root, so the seeder carries no deployment knowledge.
 *
 * Only the boot backfill REPLACES a pool whose seed changed; board creation only inserts. During a
 * rolling deploy a replica still on the previous seed keeps creating boards, and a replace there
 * would write the old seed back on every one. A replica on the previous seed that REBOOTS during
 * the rollout still writes it back once; the next boot of a replica on the new seed corrects it.
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
  connectionService: Pick<RunnerPoolConnectionService, 'seedAccount' | 'reseedAccount'>
  accountRepository: Pick<AccountRepository, 'get' | 'listAll'>
  accountRunnerPoolRepository: Pick<AccountRunnerPoolRepository, 'getByAccount' | 'listByAccounts'>
  seedSource: RunnerPoolSeedSource
  logger?: Logger
}): RunnerPoolSeeder {
  const { connectionService, accountRepository, accountRunnerPoolRepository, seedSource, logger } =
    deps

  /** Seed `account`, or bring its `current` pool in line with the seed when it has one. */
  async function seedOne(account: AccountRecord, current?: AccountRunnerPoolRecord): Promise<void> {
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
      const fields = { accountId: account.id, kind: parsed.output.config.kind }
      if (current) {
        if (await connectionService.reseedAccount(current, parsed.output)) {
          logger?.info('replaced account runner pool with the changed seed', fields)
        }
      } else if (await connectionService.seedAccount(account.id, parsed.output)) {
        logger?.info('seeded account runner pool', fields)
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
        const pools = new Map(
          (await accountRunnerPoolRepository.listByAccounts(accounts.map((a) => a.id))).map(
            (row) => [row.accountId, row],
          ),
        )
        for (const account of accounts) await seedOne(account, pools.get(account.id))
      } catch (error) {
        logger?.warn('could not enumerate accounts to seed runner pools', describeError(error))
      }
    },
  }
}
