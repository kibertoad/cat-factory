import type {
  PreflightCheckId,
  PreflightHostProbes,
  PreflightParams,
  PreflightProbeOutcome,
  PreflightRef,
  PreflightResult,
  PreflightStatus,
} from '@cat-factory/kernel'

// PREFLIGHT evaluation — turn a recipe's declared `prerequisites` (PreflightRef[]) into verdicts by
// running the built-in checks against an injected {@link PreflightHostProbes} seam. Runtime-neutral
// orchestration (no `node:*`): the host-bound I/O lives entirely in the probes, so this service is
// exercised in unit tests by scripting a fake probes object (the tracker's validation plan #4:
// "fake probe states drive every verdict + remediation rendering"). Built + wired ONLY where the
// probe seam exists (the local facade); elsewhere the preflight API + provision-start enforcement
// report "unavailable".

const GIB = 1024 ** 3

/** An internal per-check outcome: the probe verdict plus an optional remediation override (misconfig). */
interface CheckOutcome extends PreflightProbeOutcome {
  /** Overrides the built-in remediation — used when the ref is misconfigured for its check kind. */
  remediation?: string
}

/** A built-in check: its title, its default remediation instructions, and how it probes the host. */
interface CheckDefinition {
  title: string
  /** Copy-paste remediation shown on a non-pass verdict (the operator can override per-ref). */
  defaultRemediation: (params: PreflightParams) => string
  run: (params: PreflightParams, probes: PreflightHostProbes) => Promise<CheckOutcome>
}

/** A ref that omits a param its check requires — a clear config error, not a host failure. */
function misconfigured(message: string): CheckOutcome {
  return {
    status: 'fail',
    detail: `misconfigured: ${message}`,
    remediation: `Fix this check: ${message}.`,
  }
}

/**
 * The built-in preflight checks. Each maps a {@link PreflightRef}'s params to a host probe and
 * carries the human remediation for the inherently-manual one-time machine setup (VPN / SSO / ECR /
 * mkcert). A check whose required param is absent returns a `misconfigured` verdict rather than
 * calling the probe.
 */
const CHECKS: Record<PreflightCheckId, CheckDefinition> = {
  'docker-daemon': {
    title: 'Docker daemon reachable',
    defaultRemediation: () =>
      'The Docker daemon is not reachable. Start Docker Desktop (or `sudo systemctl start docker`) and re-run.',
    run: (_params, probes) => probes.dockerDaemon(),
  },
  'disk-space': {
    title: 'Free disk space',
    defaultRemediation: (p) =>
      `Free up disk to at least ${p.minGib ?? '?'} GiB — heavy stacks pull large images and volumes. Try \`docker system prune -a --volumes\`.`,
    run: (p, probes) =>
      p.minGib === undefined
        ? Promise.resolve(misconfigured('disk-space needs a minGib'))
        : probes.diskSpace(Math.round(p.minGib * GIB)),
  },
  memory: {
    title: 'Available memory',
    defaultRemediation: (p) =>
      `This stack needs at least ${p.minGib ?? '?'} GiB of RAM. Increase the machine's / Docker's memory allocation and re-run.`,
    run: (p, probes) =>
      p.minGib === undefined
        ? Promise.resolve(misconfigured('memory needs a minGib'))
        : probes.memory(Math.round(p.minGib * GIB)),
  },
  'registry-auth': {
    title: 'Container registry login',
    defaultRemediation: (p) =>
      `Not logged in to \`${p.registry ?? '?'}\`. Authenticate (e.g. \`aws ecr get-login-password --region <r> | docker login --username AWS --password-stdin ${p.registry ?? '<registry>'}\`, or \`docker login ${p.registry ?? '<registry>'}\`) and re-run. Registry tokens expire (ECR ~every 12h), so refresh if it was working earlier.`,
    run: (p, probes) =>
      p.registry === undefined
        ? Promise.resolve(misconfigured('registry-auth needs a registry'))
        : probes.registryAuth(p.registry),
  },
  'tcp-reachable': {
    title: 'Host reachable (TCP)',
    defaultRemediation: (p) =>
      `Could not reach \`${p.host ?? '?'}:${p.port ?? '?'}\`. If it is a VPN-only host, connect the VPN (e.g. \`tailscale up\`) and re-run.`,
    run: (p, probes) =>
      p.host === undefined || p.port === undefined
        ? Promise.resolve(misconfigured('tcp-reachable needs a host and port'))
        : probes.tcpReachable(p.host, p.port),
  },
  'http-reachable': {
    title: 'Endpoint reachable (HTTP)',
    defaultRemediation: (p) =>
      `Could not reach \`${p.url ?? '?'}\`. If it is behind a VPN, connect it (e.g. \`tailscale up\`); otherwise check the service is up and re-run.`,
    run: (p, probes) =>
      p.url === undefined
        ? Promise.resolve(misconfigured('http-reachable needs a url'))
        : probes.httpReachable(p.url, {
            ...(p.expectStatus !== undefined ? { expectStatus: p.expectStatus } : {}),
            ...(p.expectBodyContains !== undefined
              ? { expectBodyContains: p.expectBodyContains }
              : {}),
          }),
  },
  'mkcert-ca': {
    title: 'mkcert local CA installed',
    defaultRemediation: () =>
      'The mkcert local CA is not in the trust store. Install mkcert and run `mkcert -install`, then re-run.',
    run: (_params, probes) => probes.mkcertCa(),
  },
  'hosts-entries': {
    title: 'Hosts-file entries present',
    defaultRemediation: (p) =>
      `Add the required entries to your hosts file (${(p.hostnames ?? []).join(', ') || '<none configured>'}) — see the repo's setup — then re-run.`,
    run: (p, probes) =>
      !p.hostnames || p.hostnames.length === 0
        ? Promise.resolve(misconfigured('hosts-entries needs at least one hostname'))
        : probes.hostsEntries(p.hostnames),
  },
  'env-secrets-marker': {
    title: 'Secrets populated',
    defaultRemediation: (p) =>
      `\`${p.file ?? '?'}\` is missing the secrets marker (\`${p.marker ?? '?'}\`). Run the repo's secrets step (e.g. the Vault pull) to populate it, then re-run.`,
    run: (p, probes) =>
      p.file === undefined || p.marker === undefined
        ? Promise.resolve(misconfigured('env-secrets-marker needs a file and marker'))
        : probes.envSecretsMarker(p.file, p.marker),
  },
}

/**
 * Downgrade a probe verdict by the ref's `required` flag: a failing REQUIRED check BLOCKS the
 * provision (`fail`); a failing non-required check is advisory (`warn`). A `pass`/`warn` probe
 * verdict is passed through unchanged.
 */
function resolveStatus(probe: PreflightStatus, required: boolean): PreflightStatus {
  if (probe === 'pass') return 'pass'
  if (probe === 'warn') return 'warn'
  return required ? 'fail' : 'warn'
}

/**
 * Evaluate a workspace's declared preflight checks against the host. The host-bound probes are the
 * injected seam (local facade only); this service is pure orchestration + verdict shaping, so it is
 * fully unit-tested with a scripted fake. Checks run concurrently; the results preserve ref order.
 */
export class PreflightService {
  private readonly probes: PreflightHostProbes

  constructor(deps: { hostProbes: PreflightHostProbes }) {
    this.probes = deps.hostProbes
  }

  /** Run each ref's check and return one {@link PreflightResult} per ref, in order. Never throws. */
  async run(refs: PreflightRef[]): Promise<PreflightResult[]> {
    return Promise.all(refs.map((ref) => this.evaluate(ref)))
  }

  private async evaluate(ref: PreflightRef): Promise<PreflightResult> {
    const def = CHECKS[ref.check]
    const params = ref.params ?? {}
    const required = ref.required ?? true
    const title = ref.label ?? def.title
    let outcome: CheckOutcome
    try {
      outcome = await def.run(params, this.probes)
    } catch (err) {
      // The probes are contracted to never throw, but a bug there must still yield a verdict.
      outcome = { status: 'fail', detail: err instanceof Error ? err.message : String(err) }
    }
    const status = resolveStatus(outcome.status, required)
    return {
      check: ref.check,
      title,
      status,
      required,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(status === 'pass'
        ? {}
        : {
            remediation: ref.remediation ?? outcome.remediation ?? def.defaultRemediation(params),
          }),
    }
  }
}

/** The blocking failures in a result set — the REQUIRED checks that failed (what fails a provision). */
export function preflightBlockingFailures(results: PreflightResult[]): PreflightResult[] {
  return results.filter((r) => r.status === 'fail')
}

/**
 * Render a compose-provider provision-failure message for a set of blocking preflight failures: the
 * failed checks with their detail + remediation, so `step.environment.lastError` (and the "View
 * logs" drawer) shows exactly what to fix. Only called when there is at least one blocking failure.
 */
export function formatPreflightFailure(failures: PreflightResult[]): string {
  const lines = failures.map((f) => {
    const detail = f.detail ? ` — ${f.detail}` : ''
    const fix = f.remediation ? `\n  ${f.remediation}` : ''
    return `- ${f.title}${detail}${fix}`
  })
  return `Preflight check(s) failed:\n${lines.join('\n')}`
}
