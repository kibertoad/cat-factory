import { defineMcpOAuthGrantSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1McpOAuthGrantRepository } from '../../src/infrastructure/repositories/D1McpOAuthGrantRepository'

// Cross-runtime parity for the per-workspace MCP OAuth grant store against the Worker's real D1
// repository, inside workerd. The Node facade runs the identical suite over Postgres — together
// they mandate that the composite (workspace, server) key and the refresh path's rev guard behave
// the same on both, which is what keeps a rotated refresh token from being overwritten by the
// loser of a race on one store only.
defineMcpOAuthGrantSuite('cloudflare', () => new D1McpOAuthGrantRepository({ db: env.DB }))
