// A trivial in-memory provider registry built from the wired providers, keyed by
// each provider's `kind`. Shared by the document- and task-source integrations,
// which only differ in the provider/kind types they carry.

/** Generic by-kind provider registry: look a provider up by its `kind`, or list them all. */
export class MapSourceRegistry<K, P extends { kind: K }> {
  private readonly byKind: Map<K, P>

  constructor(providers: P[]) {
    this.byKind = new Map(providers.map((p) => [p.kind, p]))
  }

  get(kind: K): P | undefined {
    return this.byKind.get(kind)
  }

  list(): P[] {
    return [...this.byKind.values()]
  }
}
