// The client a caller constructs: a transport plus the generated resource clients mounted on it.

import { type ClientOptions, Transport } from './http.ts'
import { CatFactoryResources } from './operations.generated.ts'

/**
 * A cat-factory public-API client.
 *
 * ```ts
 * const client = new CatFactoryClient({
 *   baseUrl: 'https://cat-factory.example.com',
 *   apiKey: process.env.CAT_FACTORY_API_KEY!,
 * })
 * const { services } = await client.services.list()
 * const task = await client.tasks.create(services[0].serviceId, { title: 'Add a health check' })
 * await client.tasks.start(task.taskId, {})
 * ```
 *
 * Every call is scoped to the key's workspace, and each resource client mirrors one tag of the
 * published OpenAPI surface: `jobs`, `services`, `tasks`, `pipelines`, `notifications`,
 * `webhook`, `usage`, `decisions`, `debug`.
 *
 * The client is stateless beyond its configuration, so one instance is safe to share across
 * concurrent work.
 */
// The resource properties are INHERITED from the generated `CatFactoryResources` rather than
// re-declared here. Listing them by hand would be a second copy of the surface table that nothing
// keeps in sync — a resource group added to `scripts/sdk/surface.mjs` would generate, compile, and
// simply not be reachable from the client anyone actually constructs.
//
// A base class rather than a declaration-merged `interface CatFactoryClient extends Resources {}`:
// the merge reads more cleanly, but TypeScript cannot see that such properties are ever
// initialised, so it silently gives up checking them (`no-unsafe-declaration-merging`).
export class CatFactoryClient extends CatFactoryResources {
  private readonly transport: Transport

  constructor(options: ClientOptions) {
    const transport = new Transport(options)
    super(transport)
    this.transport = transport
  }

  /**
   * Supply the personal password for a key BOUND to a user, so subsequent calls can unlock that
   * user's own model subscription (see `personalPassword` on `ClientOptions`).
   *
   * Settable after construction because that is when a caller learns it is needed: an operation
   * answers `428 credential_required`, the caller prompts (or reads its secret store), and retries.
   * Passing it at construction would mean discarding a configured client to send one header.
   *
   * A single call can still override it with `{ headers: { 'X-Personal-Password': … } }`, which is
   * what to reach for when one process drives runs for more than one person.
   */
  setPersonalPassword(password: string | undefined): void {
    this.transport.personalPassword = password
  }
}
