import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Private package registry wire contracts. A workspace connects the private
// registries its repos install from (npm private orgs, GitHub Packages) so
// agent containers (coder, tester, ci-fixer, preview, bootstrap, …) can
// resolve private dependencies on checkout: the entries ride the container
// job body and the harness renders them into `~/.npmrc` before the agent runs.
//
// The shape is ecosystem-discriminated (`ecosystem: 'npm'`) so pip/maven/cargo
// are later additive entries, not a reshape. The registry HOST is derived from
// the fixed vendor set — never user-supplied — so the harness can hard-allowlist
// where a token may be sent. Tokens are write-only: the list view carries only
// a non-secret summary (vendor + scopes + token tail).
//
// GitHub Packages uses an explicit token rather than reusing the GitHub App
// installation token: adding `packages:read` to the App would force every
// installation to re-approve, installation tokens expire in ~60 minutes (too
// short for a long run), and the npm scope's owner org can differ from the
// App's installation org. Reusing the App token stays a future option.
// ---------------------------------------------------------------------------

/** Package ecosystems a registry entry can serve (npm-only today, extensible). */
export const packageEcosystemSchema = v.picklist(['npm'])
export type PackageEcosystem = v.InferOutput<typeof packageEcosystemSchema>

/** Registry vendors a workspace can connect (fixed set — the host derives from it). */
export const packageRegistryVendorSchema = v.picklist(['npmjs', 'github-packages'])
export type PackageRegistryVendor = v.InferOutput<typeof packageRegistryVendorSchema>

/** The registry host each vendor resolves to. Never user-supplied. */
export function packageRegistryHost(vendor: PackageRegistryVendor): string {
  switch (vendor) {
    case 'npmjs':
      return 'registry.npmjs.org'
    case 'github-packages':
      return 'npm.pkg.github.com'
  }
}

/** An npm package scope (`@org`), the granularity private registries key on. */
export const npmScopeSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(2),
  v.maxLength(215),
  v.regex(
    /^@[a-z0-9~-][a-z0-9._~-]*$/i,
    'scope must look like @org (letters, digits and ._~- after the @)',
  ),
)

/** Add one registry entry to the workspace (token write-only, never read back). */
export const addPackageRegistrySchema = v.object({
  ecosystem: packageEcosystemSchema,
  vendor: packageRegistryVendorSchema,
  scopes: v.pipe(v.array(npmScopeSchema), v.minLength(1), v.maxLength(50)),
  token: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4096)),
})
export type AddPackageRegistryInput = v.InferOutput<typeof addPackageRegistrySchema>

/** A stored registry entry — the decrypted-blob shape (token included). */
export const packageRegistryEntrySchema = v.object({
  id: v.string(),
  ecosystem: packageEcosystemSchema,
  vendor: packageRegistryVendorSchema,
  scopes: v.array(npmScopeSchema),
  token: v.pipe(v.string(), v.minLength(1)),
})
export type PackageRegistryEntry = v.InferOutput<typeof packageRegistryEntrySchema>

/**
 * Validate a decrypted registry-entries blob at the read boundary, so a
 * drifted/corrupted/hand-edited row fails with a clear schema error here
 * rather than as a malformed `.npmrc` deep inside a container install.
 */
export function parsePackageRegistryEntries(raw: unknown): PackageRegistryEntry[] {
  return v.parse(v.array(packageRegistryEntrySchema), raw)
}

/** What `GET /package-registries` returns per entry — never the token. */
export const packageRegistryEntryViewSchema = v.object({
  id: v.string(),
  ecosystem: packageEcosystemSchema,
  vendor: packageRegistryVendorSchema,
  scopes: v.array(v.string()),
  /** Last characters of the token, for recognition in the UI. */
  tokenTail: v.string(),
})
export type PackageRegistryEntryView = v.InferOutput<typeof packageRegistryEntryViewSchema>

export const packageRegistryListSchema = v.object({
  entries: v.array(packageRegistryEntryViewSchema),
})
export type PackageRegistryListView = v.InferOutput<typeof packageRegistryListSchema>

/**
 * The non-secret display summary persisted alongside the sealed entries, so the
 * list view renders without ever decrypting the tokens.
 */
export function packageRegistrySummary(
  entries: PackageRegistryEntry[],
): PackageRegistryEntryView[] {
  return entries.map((entry) => ({
    id: entry.id,
    ecosystem: entry.ecosystem,
    vendor: entry.vendor,
    scopes: [...entry.scopes],
    tokenTail: entry.token.slice(-4),
  }))
}

/** Validate a persisted summary blob at the read boundary. */
export function parsePackageRegistrySummary(raw: unknown): PackageRegistryEntryView[] {
  return v.parse(v.array(packageRegistryEntryViewSchema), raw)
}
