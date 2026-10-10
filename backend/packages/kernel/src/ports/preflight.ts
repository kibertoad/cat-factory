import type { PreflightStatus } from '../domain/types.js'

// Ports for PREFLIGHTS — machine-prerequisite checks with guided remediation (the acme complex-
// monolith bring-up: VPN / ECR login / mkcert / hosts / secrets). The DECLARATION lives in
// `@cat-factory/contracts` (`PreflightRef`/`PreflightResult`, rides a recipe's provisioning blob,
// fully runtime-symmetric); the actual PROBES read the local host (Docker daemon, filesystem,
// network), so `PreflightHostProbes` is a runtime-BOUND seam implemented ONLY by the local facade
// — the documented compose exception to runtime symmetry. The integrations `PreflightService`
// composes these probes into per-ref verdicts; where the seam is unwired (Worker / plain Node) the
// service isn't built and the preflight API + provision-start enforcement report "unavailable".

/** One probe's raw outcome: a verdict plus an optional human-readable detail (free disk, HTTP status). */
export interface PreflightProbeOutcome {
  status: PreflightStatus
  detail?: string
}

/**
 * The host-bound probe seam a preflight check runs against, implemented over the docker CLI +
 * `node:*` by the local facade (`createDockerPreflightProbes`). Every probe is normalized to never
 * throw — a probe error is a `fail`/`warn` outcome, so the service always produces a verdict. The
 * `PreflightService` selects the probe per {@link PreflightCheckId} and shapes the final result
 * (title + required + remediation); the probes only report reachability/presence.
 */
export interface PreflightHostProbes {
  /** The host Docker daemon is reachable (`docker info` / `compose ls`). */
  dockerDaemon(): Promise<PreflightProbeOutcome>
  /** Free disk on the scratch/working volume is at least `minBytes`. */
  diskSpace(minBytes: number): Promise<PreflightProbeOutcome>
  /** Total machine RAM is at least `minBytes`. */
  memory(minBytes: number): Promise<PreflightProbeOutcome>
  /** A `docker login` credential is present for `registry` (checked, never stored). */
  registryAuth(registry: string): Promise<PreflightProbeOutcome>
  /** A TCP connect to `host:port` succeeds (a VPN-only Vault/ECR host). */
  tcpReachable(host: string, port: number): Promise<PreflightProbeOutcome>
  /** An HTTP GET of `url` returns the expected status / body substring. */
  httpReachable(
    url: string,
    opts?: { expectStatus?: number; expectBodyContains?: string },
  ): Promise<PreflightProbeOutcome>
  /** The mkcert local CA is installed in the host trust store. */
  mkcertCa(): Promise<PreflightProbeOutcome>
  /** Every hostname in `hostnames` is present in the host's hosts file. */
  hostsEntries(hostnames: string[]): Promise<PreflightProbeOutcome>
  /** The host file `file` exists and contains the substring `marker`. */
  envSecretsMarker(file: string, marker: string): Promise<PreflightProbeOutcome>
}
