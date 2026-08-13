// Which thrown probe a wait against THIS deployment sits through, and for how long.
//
// A pass polls one deployment for the better part of an afternoon, and the deployment it polls is
// by design a local one: the suite's own README points it at a stack run under `cat-factory
// supervise`, whose entire job is to restart the backend when it stops serving, in front of a
// `node --watch` that cycles the process whenever a watched file changes. A restart is therefore
// an ORDINARY event in the environment this suite was built for, not an exception.
//
// It cost a real pass. A `pl_build` scaffold run was 41 minutes in, with its coder and reviewer
// done and a pull request open, when the deployment cycled between two polls; the very next
// `GET /tasks/:id/run` threw `connect ECONNREFUSED 127.0.0.1:8787` and the scenario died on it.
// The deployment was back seconds later and the run went on to reach its deployer step without
// anyone watching. What was lost was the watcher, not the work.
//
// The judgement is small and lives here rather than in `deadline.ts` (the clock, which knows
// nothing about deployments) or in `probeFailure.ts` (prerequisite VERDICTS, which is a different
// reader with a different remedy). It classifies through `describeProbeFailure` rather than
// matching on messages, so this suite keeps ONE reading of a thrown probe.

import type { ProbeTolerance } from './deadline.ts'
import { describeProbeFailure } from './probeFailure.ts'

/**
 * How long a wait sits through a deployment that is not answering.
 *
 * Two minutes, sized against what a restart actually costs rather than picked round: the
 * supervisor kills the child, settles, reaps the port and relaunches, and the backend then runs
 * its migrations before it binds. The observed restart was serving again within seconds; this
 * leaves room for one that has to bring a container-backed database up with it.
 *
 * It is deliberately far SHORTER than a run budget. A deployment that is genuinely gone should be
 * reported in the couple of minutes it takes to be sure, not sat out for the remaining hour of a
 * budget that was sized for a pipeline rather than for an outage.
 */
export const DEPLOYMENT_OUTAGE_GRACE_MS = 2 * 60 * 1000

/**
 * Gateway statuses that mean "something in front of the deployment could not reach it".
 *
 * They are tolerated for the same reason a refused connection is, and they are safe to tolerate
 * because our own backend never emits them: `handleError` maps the domain vocabulary onto
 * 401/403/404/409/422/428/429/503, so a 502 or a 504 on this wire can only have been written by
 * an intermediary. A 503 is deliberately NOT here: that one IS the deployment, saying a capability
 * is unwired, and waiting for it to change its mind is waiting for nothing.
 */
const GATEWAY_STATUSES = new Set([502, 504])

/**
 * The tolerance a deployment-polling wait runs with.
 *
 * What it tolerates is the absence of an ANSWER. Anything the deployment (or something in its
 * place) actually said is returned as `null` and ends the wait, because a refusal is evidence and
 * sitting through evidence is how a wait turns a broken key or a retired route into a two-minute
 * silence followed by the wrong message.
 *
 * The `unknown` transport cause is excluded on the same principle. It means the thrown value was
 * read and matched nothing, which is as true of a bug in this suite as of an exotic socket
 * failure, and a bug that presents as an outage is a bug that gets waited on instead of reported.
 */
export function deploymentOutageTolerance(
  graceMs: number = DEPLOYMENT_OUTAGE_GRACE_MS,
): ProbeTolerance {
  return {
    graceMs,
    describe: (error) => {
      const failure = describeProbeFailure(error)
      if (failure.kind === 'unanswered') {
        return failure.cause === 'unknown'
          ? null
          : `the deployment did not answer (${failure.cause}): ${failure.detail}`
      }
      if (failure.kind === 'answered' && GATEWAY_STATUSES.has(failure.status)) {
        return (
          `something in front of the deployment answered ${failure.status}, so it could not reach ` +
          `it: ${failure.detail}`
        )
      }
      return null
    },
  }
}
