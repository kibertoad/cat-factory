// Port for MOTHERSHIP SECRET DELEGATION: sealing and unsealing an ORG-owned credential on a
// deployment that holds no key for it (docs/initiatives/mothership-mode.md, the
// secrets-delegation slice).
//
// A mothership-mode local node runs the engine on a laptop while every org/durable row lives on
// the hosted mothership. The initiative's product decision 3 splits the keys: agent/model
// credentials are sealed with a LOCAL key, and the mothership's `ENCRYPTION_KEY` never reaches
// the laptop. That split is what makes the persistence RPC safe to hand a sealed blob over: only
// ciphertext crosses the machine API.
//
// It also means a laptop cannot READ any of those blobs. A provisioned environment's access
// handle, an infra handler's secret bundle, a Datadog connection: each is sealed under the
// mothership's key the moment a hosted teammate (or the mothership's own engine) writes it, so
// the node's local cipher fails authentication on every one. Before this port that surfaced as an
// opaque decrypt failure deep inside a provisioning or gate-probe path, and the affected
// surfaces were simply parked off the allow-list.
//
// The delegation closes it the way the notification relay closed external delivery: the node
// names the ROW, never the ciphertext. A mothership re-reads the row from its own store, checks
// it against the node's account scope, decrypts it under its own key and answers with the
// plaintext. So the endpoint is not a decryption oracle: a node can only ever ask for a value
// it could already have read had it held the key, in an account it can already reach.
//
// {@link createOrgSecretCipher} is the seam every consuming service uses, so a deployment with no
// delegate wired (every hosted deployment) is byte-for-byte the prior behaviour.

import type { SecretCipher } from './secret-cipher.js'

/**
 * The CLOSED vocabulary of org-owned sealed secrets a mothership will unseal for a node.
 *
 * It is closed for the same reason the persistence allow-list is: the delegation bypasses the
 * service layer entirely, so what a node may ask for has to be enumerated rather than derived.
 * Each member is bound on the server side to exactly one repository read, one record field and
 * one HKDF `info` tag (`SEALED_SECRET_SOURCES` in `@cat-factory/server`), and a member with no
 * such binding fails to compile.
 *
 * Adding a member is a deliberate widening: it admits one more org credential to a laptop, so it
 * belongs only where the run path genuinely needs the plaintext ON the node (provisioning
 * infrastructure, probing a monitor) rather than merely needs the row.
 */
export const ORG_SECRET_SOURCES = [
  /** `environments.access_cipher`: a provisioned environment's access handle. */
  'environment_access',
  /** `environments.provision_fields_cipher`: the resolved provision-time field values. */
  'environment_provision_fields',
  /** `environment_connections.secrets_cipher`: an infra handler's secret bundle. */
  'environment_connection',
  /** `observability_connections.credentials`: the release-health vendor credentials. */
  'observability_connection',
  /** `incident_enrichment_connections.credentials`: the PagerDuty / incident.io credentials. */
  'incident_enrichment_connection',
  /** `document_connections.credentials`: a workspace's document-source credential bag. */
  'document_source_connection',
  /** `task_connections.credentials`: a workspace's tracker credential bag. */
  'task_source_connection',
] as const

export type OrgSecretSource = (typeof ORG_SECRET_SOURCES)[number]

/**
 * How many trailing identifier args each source's declared read takes after `workspaceId`.
 *
 * It lives HERE, beside the vocabulary, rather than only in the server's `SEALED_SECRET_SOURCES`
 * bindings, because arity is the one part of a binding the CALLER has to get right and the caller
 * cannot see that table: `@cat-factory/integrations` does not depend on `@cat-factory/server`.
 * Stated only there, it was prose a call site could disagree with in silence — the mothership
 * answers 422 and every open of that source fails on the one deployment shape it exists to serve.
 * With the numbers here, {@link orgSecretRef} turns the same disagreement into a build failure,
 * and the server reads these rather than restating them, so the two halves cannot drift.
 *
 * `satisfies` (not `:`) so each member keeps its literal type for the tuple maths below while the
 * `Record` still fails to compile when a source is added without an arity.
 */
export const ORG_SECRET_KEY_ARITY = {
  environment_access: 1,
  environment_provision_fields: 1,
  environment_connection: 2,
  observability_connection: 0,
  incident_enrichment_connection: 0,
  document_source_connection: 1,
  task_source_connection: 1,
} as const satisfies Record<OrgSecretSource, number>

/** The declared arity of each source, as literal types. */
export type OrgSecretKeyArity = typeof ORG_SECRET_KEY_ARITY

/**
 * The sources whose declared read takes exactly `N` trailing args.
 *
 * A generic helper that opens a whole FAMILY of rows (the sealed connection store serves both
 * document and tracker connections) constrains its source to this rather than to
 * {@link OrgSecretSource}, so the key it builds is checked even though it never names one member.
 */
export type OrgSecretSourceOfArity<N extends number> = {
  [S in OrgSecretSource]: OrgSecretKeyArity[S] extends N ? S : never
}[OrgSecretSource]

/** A key of exactly `N` row identifiers. */
type SecretKeyTuple<N extends number, Acc extends (string | null)[] = []> = Acc['length'] extends N
  ? Acc
  : SecretKeyTuple<N, [...Acc, string | null]>

/** The key shape one source takes: `[]` for a workspace-keyed read, `[id]`, `[a, b]`, … */
export type OrgSecretKeyOf<S extends OrgSecretSource> = SecretKeyTuple<OrgSecretKeyArity[S]>

/**
 * Identifies ONE org-owned sealed secret, by row rather than by ciphertext.
 *
 * `workspaceId` is what binds the request to an account (resolved server-side exactly as the
 * persistence RPC's `workspace` rule does); `key` carries whatever trailing identifiers the
 * source's declared read takes after it (an environment id, a provision type + manifest id, …).
 * A source whose read is workspace-keyed alone passes no `key` at all.
 *
 * A UNION over the vocabulary rather than one open shape, so a literal is checked against the
 * arity its own source declared: a ref for a `(workspace, source)`-keyed row with no `key` matches
 * no member and fails to compile, where the earlier optional-array shape accepted it and failed at
 * runtime on the mothership.
 */
export type DelegatedSecretRef = {
  [S in OrgSecretSource]: { source: S; workspaceId: string } & (OrgSecretKeyArity[S] extends 0
    ? { key?: readonly [] }
    : { key: OrgSecretKeyOf<S> })
}[OrgSecretSource]

/**
 * Build a {@link DelegatedSecretRef}, with the source's own key arity enforced by the signature.
 *
 * The door for a caller whose `source` is not a literal, which a union type alone cannot check.
 * The rest parameter IS the source's declared key tuple, so passing too few (or too many)
 * identifiers is a build failure at the call site rather than a 422 from the mothership.
 */
export function orgSecretRef<S extends OrgSecretSource>(
  source: S,
  workspaceId: string,
  ...key: OrgSecretKeyOf<S>
): DelegatedSecretRef {
  // The one assertion in this module, and it is what the function is FOR rather than a hole in
  // it: the signature above is the guarantee, and the compiler cannot re-derive the
  // source-to-arity correspondence from a still-generic `S` on the way out.
  return { source, workspaceId, key } as DelegatedSecretRef
}

/** Where a delegated seal lands: the source decides which cipher (HKDF `info` tag) is used. */
export type DelegatedSealRef = Pick<DelegatedSecretRef, 'source' | 'workspaceId'>

/**
 * The client half of the delegation: asks a mothership to open (or seal) one org secret.
 *
 * Both methods REJECT rather than answering a fallback value. An unreachable mothership and a
 * secret that genuinely holds nothing are opposite facts, and a consumer that cannot tell them
 * apart would provision against an empty credential bundle or report a monitor as unconfigured.
 */
export interface SecretDelegate {
  /**
   * The plaintext behind `ref`'s sealed field. Rejects when the mothership is unreachable, the
   * row is out of the node's scope, or the row holds no sealed value (the caller read the row to
   * get here, so an empty answer is a disagreement worth surfacing, not a null).
   */
  unseal(ref: DelegatedSecretRef): Promise<string>
  /** An envelope sealed under the ORG's key, so the mothership and its hosted clients can read it. */
  seal(ref: DelegatedSealRef, plaintext: string): Promise<string>
}

/**
 * A cipher for ORG-owned secrets, addressed by ROW rather than by envelope alone.
 *
 * The extra `ref` argument is the whole point: it is what lets the sealing key live somewhere the
 * caller cannot reach, because a delegate can look the row up and prove the caller is entitled to
 * it. A plain {@link SecretCipher} cannot be delegated for exactly that reason: an envelope on
 * its own carries no claim about who may open it.
 */
export interface OrgSecretCipher {
  /**
   * Open `envelope`, which must be the sealed value `ref` names. `envelope` is used only on the
   * LOCAL path; a delegated open re-reads the authoritative row on the mothership, which is what
   * keeps the delegation from being an oracle over arbitrary ciphertext.
   */
  decryptFor(ref: DelegatedSecretRef, envelope: string): Promise<string>
  /** Seal `plaintext` for storage under `ref`'s source. */
  encryptFor(ref: DelegatedSealRef, plaintext: string): Promise<string>
}

export interface OrgSecretCipherOptions {
  /** The deployment's own cipher for this source's HKDF `info` tag. */
  cipher: SecretCipher
  /**
   * Present ONLY on a mothership-mode node. When wired, EVERY call routes to the mothership: the
   * sources above are org state by construction, so a node holds no key that can open (or usefully
   * seal) one. Routing conditionally (trying the local key first and falling back on failure)
   * would seal new rows under a key the org cannot read, which is the same silent split this
   * delegation exists to remove.
   */
  delegate?: SecretDelegate
}

/**
 * Compose a deployment's own cipher with an optional mothership delegate.
 *
 * With no delegate (every hosted deployment, and local mode against its own Postgres) this is a
 * pass-through: `decryptFor`/`encryptFor` are the underlying `decrypt`/`encrypt` and the `ref` is
 * inert. That is deliberate: a delegation seam must be invisible where nothing is delegated.
 */
export function createOrgSecretCipher(options: OrgSecretCipherOptions): OrgSecretCipher {
  const { cipher, delegate } = options
  if (!delegate) {
    return {
      decryptFor: (_ref, envelope) => cipher.decrypt(envelope),
      encryptFor: (_ref, plaintext) => cipher.encrypt(plaintext),
    }
  }
  return {
    decryptFor: (ref) => delegate.unseal(ref),
    encryptFor: (ref, plaintext) => delegate.seal(ref, plaintext),
  }
}
