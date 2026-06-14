import { Container } from '@cloudflare/containers'
import type { Env } from '../env'

// One container instance per run: Cloudflare Containers map a Durable Object id
// to a dedicated container, so addressing `env.IMPL_CONTAINER.get(<executionId>)`
// gives each execution its own ephemeral sandbox. The container runs the Pi
// coding-agent harness (see @cat-factory/implementer-harness) listening on 8080;
// the base `Container.fetch` proxies inbound requests there once it has booted.
//
// No secrets are configured here: the image carries none, and the per-job GitHub
// token + LLM session token are passed in the `/run` request body at dispatch
// time, never via image build args or class-level env vars.
export class ImplementationContainer extends Container<Env> {
  // The harness HTTP server port (matches the Dockerfile ENTRYPOINT).
  override defaultPort = 8080
  // A run is one request; let the instance sleep (and be reclaimed) shortly after
  // it goes idle so containers stay effectively ephemeral and per-run.
  override sleepAfter = '5m'
}
