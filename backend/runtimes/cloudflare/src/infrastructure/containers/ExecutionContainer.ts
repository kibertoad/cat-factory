import { RunContainer } from './RunContainer'

// One container instance per run: Cloudflare Containers map a Durable Object id to a dedicated
// container, so addressing `env.EXEC_CONTAINER.get(<executionId>)` gives each execution its own
// ephemeral sandbox running the Pi coding-agent harness (see @cat-factory/executor-harness).
//
// Everything this class does (the port, the inbound-auth secret, the idle window, the
// reclaim-cause bookkeeping, `shutdown`) is {@link RunContainer}'s. The class exists
// because a Cloudflare Container's image is pinned per container CLASS by the wrangler
// `[[containers]]` block: this one is bound as `EXEC_CONTAINER` and carries the executor image.
export class ExecutionContainer extends RunContainer {}
