import { parse as parseYaml } from 'yaml'
import type {
  ApiContractFormat,
  ApiContractSummary,
  CapabilityCredential,
  FoundationalServiceSelection,
  UploadApiContract,
} from '@cat-factory/contracts'
import {
  credentialInjectionName,
  operationsAreIndexable,
  reservedCapabilityNearMiss,
} from '@cat-factory/contracts'
import { extractFencedDeclaration } from './fenced-declaration.js'

// ---------------------------------------------------------------------------
// Pure logic for the FOUNDATIONAL SERVICES catalog
// (backend/docs/adr/0031-foundational-services.md): recognise a contract document,
// index an OpenAPI document's operations, render the two agent-facing surfaces
// (the cheap catalog the Architect designs against and the lazily-read contract
// bundle its consumers get), and read back the ids the Architect declared.
//
// No I/O and no repository access, so every rule here is unit-testable and both
// runtime facades get identical behaviour by construction.
// ---------------------------------------------------------------------------

/**
 * How many operations of one OpenAPI document ride the CATALOG. The catalog is folded into
 * the Architect's prompt for EVERY registered service, so this is multiplied by the whole
 * catalog size; the cap is what keeps a design dispatch's context proportional to the number
 * of services rather than to the size of their specs. Anything dropped is COUNTED
 * (`omittedOperations`) and stated, never silently truncated.
 */
export const MAX_CATALOG_OPERATIONS = 40

/**
 * How many bytes of ONE contract document ride a consumer's injected context file. A
 * downstream kind reads the documents for only the services the Architect declared, so this
 * bounds a handful of files rather than the catalog — hence far larger than the catalog cap.
 * An over-long document is truncated with an explicit trailing note (see
 * {@link renderContractDocument}), because a silently-cut OpenAPI document reads as a complete
 * API that happens to stop at `/f`.
 */
export const MAX_CONTRACT_BODY_CHARS = 120_000

/** The `.cat-context/` directory the resolved contract documents are injected under. */
export const FOUNDATIONAL_CONTEXT_DIR = 'foundational-services'

/** The index file listing what was injected (and what was asked for but could not be). */
export const FOUNDATIONAL_INDEX_FILE = `${FOUNDATIONAL_CONTEXT_DIR}/index.md`

/**
 * The catalog file a DESIGN-time kind reads. Deliberately the same delivery mechanism as the
 * contract documents (an injected `.cat-context/` file) rather than a new prompt field: it
 * works unchanged for a container dispatch, an inline call and a consensus participant, and
 * the trait guidance can name one stable path instead of three prompt-assembly sites having
 * to agree on a rendering.
 */
export const FOUNDATIONAL_CATALOG_FILE = `${FOUNDATIONAL_CONTEXT_DIR}/catalog.md`

/**
 * The file an ORIENTATION-time kind reads: a triage or investigation agent that has to work out
 * WHICH of the organisation's services a piece of work belongs to.
 *
 * A separate path from {@link FOUNDATIONAL_CATALOG_FILE} carrying a separate rendering of the
 * same rows, because the two readers need opposite framings of them. The catalog file tells a
 * designer "prefer consuming one of these over building your own", which is the wrong sentence
 * to put in front of an agent whose job is to locate a fault: it invites a triage report that
 * recommends adopting a shared service. The estate file states ownership and interface surface
 * and asks for neither a preference nor a declaration.
 */
export const FOUNDATIONAL_ESTATE_FILE = `${FOUNDATIONAL_CONTEXT_DIR}/estate.md`

/**
 * The fenced block the Architect writes its declaration in. Parsed back by
 * {@link parseFoundationalDeclaration}; named in the trait guidance so the two cannot drift.
 */
export const FOUNDATIONAL_DECLARATION_TAG = 'foundational-services'

// --- format recognition ---------------------------------------------------

/**
 * Recognise a contract document's format from its PATH and CONTENT.
 *
 * Content leads and the extension only breaks ties: a `.json` file is an OpenAPI document
 * when it declares `openapi: 3.x` and nothing at all otherwise, and a `.ts` module is told
 * apart by which contract library it imports. Returns null when the file is not a contract
 * we can serve — the caller reports that as a SKIPPED file, never as an empty service.
 */
export function detectContractFormat(path: string, content: string): ApiContractFormat | null {
  const lower = path.toLowerCase()
  if (endsWithAny(lower, CONTRACT_MODULE_EXTENSIONS)) {
    if (content.includes('@lokalise/api-contract')) return 'lokalise-api-contract'
    if (content.includes('@toad-contracts/')) return 'toad-contract'
    return null
  }
  if (endsWithAny(lower, GRAPHQL_DOCUMENT_EXTENSIONS)) return 'graphql'
  if (endsWithAny(lower, PROTOBUF_DOCUMENT_EXTENSIONS)) return 'grpc'
  if (endsWithAny(lower, STRUCTURED_DOCUMENT_EXTENSIONS)) {
    if (isOpenApiDocument(content)) return 'openapi'
    // AsyncAPI shares OpenAPI's extensions and its envelope shape, so the two are told apart by
    // the version key alone. Checked SECOND rather than in parallel because a document carrying
    // both keys is malformed either way and `openapi` is the one whose operations are indexed.
    return isAsyncApiDocument(content) ? 'asyncapi' : null
  }
  return null
}

/** Extensions a TypeScript/JavaScript contract MODULE can carry. */
const CONTRACT_MODULE_EXTENSIONS = ['.ts', '.mts', '.js']

/**
 * Extensions a STRUCTURED (JSON/YAML) API document can carry: an OpenAPI or an AsyncAPI one.
 *
 * Shared between the two on purpose: they are the same serialisation and differ only in the
 * version key their envelope declares, so a per-format extension list would be two copies of
 * one fact and would make `service.asyncapi.yaml` unreadable for no reason.
 */
const STRUCTURED_DOCUMENT_EXTENSIONS = ['.json', '.yaml', '.yml', '.openapi', '.asyncapi']

/** Extensions a GraphQL schema (SDL) can carry. */
const GRAPHQL_DOCUMENT_EXTENSIONS = ['.graphql', '.graphqls', '.gql']

/** Extensions a Protocol Buffers service definition can carry. */
const PROTOBUF_DOCUMENT_EXTENSIONS = ['.proto']

/**
 * Basenames that carry a contract EXTENSION but are never served as contracts: the package,
 * lockfile and compiler manifests every repository root holds.
 *
 * Without this the extension test alone is nearly useless at a repo root, where `.json` and
 * `.yaml` describe dependencies far more often than APIs. Two costs follow, and the second is
 * the one that bites: a folder scan's file budget is spent on manifests before the walk ever
 * descends to the specs, so the cap falls on exactly the documents the link exists to serve —
 * and `skippedFiles` then reports a number that restates the repo's contents instead of
 * explaining a thin catalog entry.
 *
 * Deliberately TIGHT. Everything here is a file whose name is fixed by a package manager or a
 * compiler, so no repository can mean an API contract by it; anything repo-specific is left to
 * the content check, which is the real boundary. Extending this list is a decision about what
 * we SERVE, not a heuristic — a file named `package.json` is not offered as an API contract
 * even in the absurd case that its bytes parse as one.
 */
const NON_CONTRACT_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'composer.json',
  'deno.json',
  'jsconfig.json',
])

/** `tsconfig.json` and every `tsconfig.<variant>.json` a monorepo package carries. */
const TSCONFIG_BASENAME = /^tsconfig(\..+)?\.json$/

/**
 * Whether a path could yield a contract format at all — the half of
 * {@link detectContractFormat} that is decidable without the body.
 *
 * A folder-mode repo source walks directories nobody enumerated by hand, so without this it
 * would fetch every README, lockfile and image in the subtree only to learn each is not a
 * contract. This keeps a scan's file reads proportional to the CANDIDATES rather than to the
 * folder's size.
 *
 * The extension half is derived from the same lists `detectContractFormat` branches on, so the
 * two cannot drift. The basename half ({@link NON_CONTRACT_BASENAMES}) is definitional rather
 * than derived: a candidate may still be rejected on its content, and a non-candidate is never a
 * contract we serve.
 */
export function isContractCandidatePath(path: string): boolean {
  const lower = path.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  if (NON_CONTRACT_BASENAMES.has(base) || TSCONFIG_BASENAME.test(base)) return false
  return CONTRACT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * Every extension a contract document can carry, in ONE list so the candidate test and the
 * detector can never disagree about what is worth reading.
 */
const CONTRACT_EXTENSIONS = [
  ...CONTRACT_MODULE_EXTENSIONS,
  ...STRUCTURED_DOCUMENT_EXTENSIONS,
  ...GRAPHQL_DOCUMENT_EXTENSIONS,
  ...PROTOBUF_DOCUMENT_EXTENSIONS,
]

/**
 * Whether `path` names a TypeScript/JavaScript contract MODULE rather than an OpenAPI document,
 * derived from the same extension list {@link detectContractFormat} branches on.
 *
 * Exported so a caller asking "could this file be part of a contract module GRAPH?" — the repo
 * source's supporting-module admission — asks the one list instead of re-declaring it. A second
 * copy drifts silently, and the drift surfaces as a linked file skipped as `unrecognised` for an
 * extension the detector beside it already recognises.
 */
export function isContractModulePath(path: string): boolean {
  return endsWithAny(path.toLowerCase(), CONTRACT_MODULE_EXTENSIONS)
}

function endsWithAny(lower: string, extensions: string[]): boolean {
  return extensions.some((extension) => lower.endsWith(extension))
}

/** Whether `content` parses as an OpenAPI **3.x** document (JSON or YAML). */
export function isOpenApiDocument(content: string): boolean {
  const doc = parseOpenApiDocument(content)
  return doc !== null
}

/**
 * Parse an OpenAPI 3.x document from JSON or YAML, or null when it is neither. YAML's parser
 * accepts JSON, so ONE parse covers both; the version check is what makes this a recognition
 * rather than "any object with a paths key" (Swagger 2.0 documents are a different shape and
 * the operation index below would silently produce nothing for one).
 */
function parseOpenApiDocument(content: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch {
    // silent-catch-ok: an unparseable document is simply "not OpenAPI"; the caller reports
    // the file as unrecognised, and the parse error itself names only the file's own syntax.
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  const version = doc.openapi
  if (typeof version !== 'string' || !version.startsWith('3.')) return null
  return doc
}

/** Whether `content` parses as an AsyncAPI **2.x/3.x** document (JSON or YAML). */
export function isAsyncApiDocument(content: string): boolean {
  return parseAsyncApiDocument(content) !== null
}

/**
 * Parse an AsyncAPI 2.x/3.x document from JSON or YAML, or null when it is neither.
 *
 * The twin of {@link parseOpenApiDocument} and deliberately as strict: the `asyncapi` version key
 * is what separates an event-driven interface from the many other `channels`-bearing YAML files a
 * repo holds (a broker config, a Kafka Connect descriptor), and accepting any of them would
 * register a service whose "interface" is infrastructure config.
 */
function parseAsyncApiDocument(content: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch {
    // silent-catch-ok: an unparseable document is simply "not AsyncAPI"; the caller reports the
    // file as unrecognised, and the parse error names only the file's own syntax.
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  const version = doc.asyncapi
  if (typeof version !== 'string') return null
  return version.startsWith('2.') || version.startsWith('3.') ? doc : null
}

// --- operation indexing ----------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']

/** The per-channel operation keys AsyncAPI **2.x** declares (3.x moved these to `operations`). */
const ASYNCAPI_2_CHANNEL_OPERATIONS = ['publish', 'subscribe']

/**
 * The operations an AsyncAPI document declares, as `PUBLISH orders/created` strings, capped at
 * {@link MAX_CATALOG_OPERATIONS}.
 *
 * Both major versions are read, because an org's portal will hold documents of each and the two
 * state the same fact in different places:
 *
 * - **2.x** puts the verb under the channel (`channels['orders/created'].subscribe`), so the
 *   operation is the channel name plus which side of it the document declares.
 * - **3.x** hoists them into a top-level `operations` map whose entries carry an `action`
 *   (`send`/`receive`) and a `$ref` to the channel, so the operation is the action plus the
 *   channel the ref names, falling back to the operation's own key when the ref is not a local
 *   `#/channels/<name>` pointer. That fallback is the honest half: following an external ref
 *   would need a fetch this parser will not make, and the key is the document's own name for
 *   the operation rather than an invented one.
 *
 * A document whose version is neither indexes to nothing rather than being guessed at.
 */
export function indexAsyncApiOperations(content: string): {
  operations: string[]
  omitted: number
} {
  const doc = parseAsyncApiDocument(content)
  if (!doc) return { operations: [], omitted: 0 }
  const all = String(doc.asyncapi).startsWith('3.')
    ? asyncApi3Operations(doc)
    : asyncApi2Operations(doc)
  all.sort()
  return {
    operations: all.slice(0, MAX_CATALOG_OPERATIONS),
    omitted: Math.max(0, all.length - MAX_CATALOG_OPERATIONS),
  }
}

function asyncApi2Operations(doc: Record<string, unknown>): string[] {
  const channels = doc.channels
  if (!channels || typeof channels !== 'object') return []
  const out: string[] = []
  for (const [channel, item] of Object.entries(channels as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue
    for (const operation of ASYNCAPI_2_CHANNEL_OPERATIONS) {
      if (operation in (item as Record<string, unknown>)) {
        out.push(`${operation.toUpperCase()} ${channel}`)
      }
    }
  }
  return out
}

function asyncApi3Operations(doc: Record<string, unknown>): string[] {
  const operations = doc.operations
  if (!operations || typeof operations !== 'object') return []
  const out: string[] = []
  for (const [key, item] of Object.entries(operations as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue
    const operation = item as { action?: unknown; channel?: { $ref?: unknown } }
    const action = typeof operation.action === 'string' ? operation.action.toUpperCase() : null
    if (!action) continue
    out.push(`${action} ${asyncApi3ChannelName(operation.channel?.$ref) ?? key}`)
  }
  return out
}

/** The channel a 3.x operation's `$ref` names, when it is a local `#/channels/<name>` pointer. */
function asyncApi3ChannelName(ref: unknown): string | null {
  if (typeof ref !== 'string') return null
  const local = /^#\/channels\/(.+)$/.exec(ref)
  const pointer = local?.[1]
  if (!pointer) return null
  // AsyncAPI escapes `/` in a JSON-Pointer segment as `~1` (and `~` as `~0`), which is what a
  // slash-bearing channel name like `orders/created` becomes. Decoding is what stops the
  // rendered operation naming a channel the document does not contain. `~1` is unescaped first
  // and `~0` second, which is the order RFC 6901 fixes: the reverse turns a literal `~1` into a
  // slash.
  return pointer.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * The operations an OpenAPI document declares, as `GET /files/{id}` strings, capped at
 * {@link MAX_CATALOG_OPERATIONS}. Returns `omitted` so the caller can STATE that the list is
 * a prefix — a reader who assumed otherwise would conclude the tail does not exist.
 *
 * A non-OpenAPI document (a TypeScript contract module) indexes to nothing: those are not
 * parsed, and inventing operation names from a regex over source would be a guess presented
 * as a fact.
 */
export function indexOpenApiOperations(content: string): {
  operations: string[]
  omitted: number
} {
  const doc = parseOpenApiDocument(content)
  const paths = doc?.paths
  if (!paths || typeof paths !== 'object') return { operations: [], omitted: 0 }
  const all: string[] = []
  for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
    if (!item || typeof item !== 'object') continue
    for (const method of HTTP_METHODS) {
      if (method in (item as Record<string, unknown>)) {
        all.push(`${method.toUpperCase()} ${path}`)
      }
    }
  }
  all.sort()
  return {
    operations: all.slice(0, MAX_CATALOG_OPERATIONS),
    omitted: Math.max(0, all.length - MAX_CATALOG_OPERATIONS),
  }
}

/**
 * Index a document's operations by its FORMAT — the one dispatch, so every write site indexes
 * a document the same way. A format {@link operationsAreIndexable} says nothing about indexes
 * to nothing, which is a different statement from "declares nothing" and is rendered as such.
 */
export function indexContractOperations(
  format: ApiContractFormat,
  body: string,
): { operations: string[]; omitted: number } {
  if (format === 'openapi') return indexOpenApiOperations(body)
  if (format === 'asyncapi') return indexAsyncApiOperations(body)
  if (format === 'toad-contract') return indexToadContractOperations(body)
  return { operations: [], omitted: 0 }
}

// --- contract MODULE indexing ---------------------------------------------

/** The call a `@toad-contracts/core` module declares each of its operations with. */
const TOAD_ANCHOR = /defineApiContract\s*\(/g

/** `method: 'post'` inside one contract's object literal. */
const TOAD_METHOD = /\bmethod\s*:\s*['"](get|put|post|delete|patch|head|options|trace)['"]/i

/** `pathResolver: () => '/x'` / `pathResolver: ({ id }) => `/x/${id}`` — the literal forms only. */
const TOAD_PATH_RESOLVER =
  /\bpathResolver\s*:\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*(`[^`]*`|'[^']*'|"[^"]*")/

/** A `${…}` hole a path template may carry, when it is a plain identifier or member path. */
const TEMPLATE_HOLE = /\$\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}/g

/**
 * How much source after a `defineApiContract(` anchor is scanned for that contract's `method`
 * and `pathResolver`. The scan stops at the NEXT anchor, so this only bounds the last (or a
 * pathologically long) declaration; a contract whose fields sit further out than this reads as
 * unextractable, which is a reported omission rather than a wrong answer.
 */
const TOAD_DECLARATION_WINDOW = 4_000

/**
 * The operations a `@toad-contracts/core` module declares, read STATICALLY from its source.
 *
 * A contract module cannot be evaluated (no code generation in a Worker isolate, and executing
 * an uploaded module would be a remote-code-execution hole), so this is a deliberately partial
 * parse of the one shape the library documents: a `defineApiContract({ method, pathResolver })`
 * call whose resolver returns a string or template literal. `${param}` holes become `{param}`,
 * which is the same rendering an OpenAPI path template uses.
 *
 * Two properties make a partial parse honest rather than a guess:
 *
 *  - the ANCHOR count is the declaration count. `defineApiContract(` is the only way the
 *    library declares an operation, so what could not be read is `declared - extracted` and is
 *    reported as `omitted` — the same channel the OpenAPI cap uses. A reader is never shown a
 *    subset that looks complete.
 *  - anything the extractor is not certain of is NOT emitted: a computed path, a resolver built
 *    elsewhere, a method held in a variable. An invented operation name is worse than a missing
 *    one, because a coder writes against it.
 */
export function indexToadContractOperations(content: string): {
  operations: string[]
  omitted: number
} {
  const anchors: number[] = []
  TOAD_ANCHOR.lastIndex = 0
  for (let m = TOAD_ANCHOR.exec(content); m !== null; m = TOAD_ANCHOR.exec(content)) {
    anchors.push(m.index + m[0].length)
  }
  const found: string[] = []
  for (const [i, start] of anchors.entries()) {
    const end = Math.min(anchors[i + 1] ?? content.length, start + TOAD_DECLARATION_WINDOW)
    const declaration = content.slice(start, end)
    const method = TOAD_METHOD.exec(declaration)?.[1]
    const path = TOAD_PATH_RESOLVER.exec(declaration)?.[1]
    if (!method || !path) continue
    const template = pathTemplateFrom(path)
    if (template === null) continue
    found.push(`${method.toUpperCase()} ${template}`)
  }
  found.sort()
  const operations = found.slice(0, MAX_CATALOG_OPERATIONS)
  return { operations, omitted: Math.max(0, anchors.length - operations.length) }
}

/**
 * A path literal's source → its `{param}` template, or null when it interpolates something
 * this parser cannot name (a ternary, a call, a concatenation).
 */
function pathTemplateFrom(literal: string): string | null {
  const inner = literal.slice(1, -1)
  if (!literal.startsWith('`')) return inner.startsWith('/') ? inner : null
  const rendered = inner.replace(TEMPLATE_HOLE, (_match, name: string) => `{${name}}`)
  if (rendered.includes('${')) return null
  return rendered.startsWith('/') ? rendered : null
}

// --- write-boundary validation --------------------------------------------

/** The package import each TypeScript contract format is recognised by. */
const CONTRACT_LIBRARY: Partial<Record<ApiContractFormat, { package: string; label: string }>> = {
  'toad-contract': { package: '@toad-contracts/', label: '@toad-contracts/core' },
  'lokalise-api-contract': { package: '@lokalise/api-contract', label: '@lokalise/api-contract' },
}

/** Something wrong with a service definition, whoever supplied it. */
export type FoundationalDefinitionProblem =
  | { reason: 'duplicate_contract_id'; contractId: string }
  | { reason: 'invalid_openapi_document'; contractId: string }
  | { reason: 'invalid_asyncapi_document'; contractId: string }
  | {
      reason: 'contract_library_not_referenced'
      format: ApiContractFormat
      expected: string
      contractIds: string[]
    }
  | { reason: 'capability_tag_near_miss'; capability: string; expected: string }

/**
 * Refuse a service definition whose documents will read as garbage to a downstream agent, at
 * the moment it is supplied rather than the moment a coder is handed it. Returns every problem
 * rather than the first, so a registrant fixes one round of them.
 *
 * ONE function for both suppliers — the REST write boundary and a deployment's code
 * registration — because the failure it prevents is identical and a second copy is a second
 * place to relax a rule.
 *
 * The checks are deliberately shallow and per-format. `openapi` is PARSED: a document claiming
 * to be OpenAPI but which is not produces a service whose catalog entry lists zero operations
 * while looking perfectly registered. The TypeScript formats cannot be evaluated, so the honest
 * check is that the SET is what it says it is.
 *
 * **The set, not each document.** A contract module is a module GRAPH — a
 * `defineApiContract` module plus the schema modules it imports — and only the first of those
 * names the contract library. Validating per document refuses the halves of one contract that
 * are not the entry point, which leaves a registrant concatenating source files to get past the
 * boundary; validating the set keeps the anchor requirement (a set declared as
 * `@toad-contracts/core` must contain a `@toad-contracts/core` module) while letting the
 * modules it imports be registered as what they are.
 */
export function validateFoundationalDefinition(input: {
  capabilities?: string[]
  contracts?: UploadApiContract[]
}): FoundationalDefinitionProblem[] {
  const problems: FoundationalDefinitionProblem[] = []
  for (const capability of input.capabilities ?? []) {
    const expected = reservedCapabilityNearMiss(capability)
    if (expected) problems.push({ reason: 'capability_tag_near_miss', capability, expected })
  }
  const contracts = input.contracts ?? []
  const seen = new Set<string>()
  for (const contract of contracts) {
    if (seen.has(contract.contractId)) {
      problems.push({ reason: 'duplicate_contract_id', contractId: contract.contractId })
    }
    seen.add(contract.contractId)
    const invalid = describeInvalidStructuredDocument(contract.format, contract.body)
    if (invalid) {
      problems.push({ reason: invalid, contractId: contract.contractId })
    }
  }
  for (const [format, library] of Object.entries(CONTRACT_LIBRARY) as [
    ApiContractFormat,
    { package: string; label: string },
  ][]) {
    const set = contracts.filter((contract) => contract.format === format)
    if (set.length === 0) continue
    if (set.some((contract) => contract.body.includes(library.package))) continue
    problems.push({
      reason: 'contract_library_not_referenced',
      format,
      expected: library.label,
      contractIds: set.map((contract) => contract.contractId),
    })
  }
  return problems
}

/** A human-readable statement of one problem, shared by every caller that reports one. */
export function describeFoundationalProblem(problem: FoundationalDefinitionProblem): string {
  switch (problem.reason) {
    case 'duplicate_contract_id':
      return `Duplicate contract id '${problem.contractId}'`
    case 'invalid_openapi_document':
      return `Contract '${problem.contractId}' is not a valid OpenAPI 3.x document (JSON or YAML)`
    case 'invalid_asyncapi_document':
      return `Contract '${problem.contractId}' is not a valid AsyncAPI 2.x/3.x document (JSON or YAML)`
    case 'contract_library_not_referenced':
      return `No document declared as '${problem.format}' (${problem.contractIds.join(', ')}) references ${problem.expected}. A set may include the modules a contract imports, but at least one of them must be the contract itself.`
    case 'capability_tag_near_miss':
      return `Capability tag '${problem.capability}' differs from the reserved tag '${problem.expected}' only in case or separators. The platform matches '${problem.expected}' exactly, so this tag would be silently ignored — use it, or pick a tag that is not a near-miss of it.`
  }
}

/**
 * Why a document does not hold up as the STRUCTURED format it was declared as, or null when it
 * does (and for every format that is not parsed here).
 *
 * Only the two JSON/YAML formats are checked, and the reason is the failure this rule exists to
 * prevent rather than a preference for parseable things: a document claiming to be OpenAPI or
 * AsyncAPI but which is neither registers cleanly and then lists ZERO operations, which reads to
 * an Architect as a fully-specified service that offers no endpoints. GraphQL SDL and protobuf
 * are not parsed at all (`operationsAreIndexable` says so), so an unparseable one produces no
 * such false impression and refusing it would need a parser whose verdict nothing else uses.
 */
function describeInvalidStructuredDocument(
  format: ApiContractFormat,
  body: string,
): 'invalid_openapi_document' | 'invalid_asyncapi_document' | null {
  if (format === 'openapi') return isOpenApiDocument(body) ? null : 'invalid_openapi_document'
  if (format === 'asyncapi') return isAsyncApiDocument(body) ? null : 'invalid_asyncapi_document'
  return null
}

/** Build the catalog-facing summary of one stored contract document. */
export function summarizeContract(input: {
  contractId: string
  format: ApiContractFormat
  title: string
  path: string | null
  body: string
}): ApiContractSummary {
  const indexed = indexContractOperations(input.format, input.body)
  return {
    contractId: input.contractId,
    format: input.format,
    title: input.title,
    size: input.body.length,
    path: input.path,
    operations: indexed.operations,
    omittedOperations: indexed.omitted,
  }
}

// --- the Architect's declaration ------------------------------------------

/**
 * Read the foundational-service ids an agent declared out of its final reply.
 *
 * The contract is a fenced ```foundational-services block holding one id per line (a leading
 * `-` bullet is tolerated, because models write lists). Everything else in the reply is
 * ignored: scanning prose for catalog ids would "find" a service the design merely mentions
 * as a rejected alternative, and the downstream consequence of a false positive is a coder
 * handed the wrong API.
 *
 * The LAST such block wins ({@link extractFencedDeclaration}) — the guidance asks the agent to
 * END its reply with it, and a model that illustrates the shape earlier would otherwise have its
 * example parsed instead of its answer.
 *
 * Ids are matched against `known` so an invented one lands in `unknown` rather than
 * disappearing — see {@link FoundationalServiceSelection}.
 */
export function parseFoundationalDeclaration(
  output: string | undefined,
  known: Iterable<string>,
): FoundationalServiceSelection {
  const empty: FoundationalServiceSelection = { declared: [], unknown: [] }
  const body = extractFencedDeclaration(output, FOUNDATIONAL_DECLARATION_TAG)
  if (body === null) return empty
  const knownIds = new Set(known)
  const declared: string[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const raw of body.split(/\r?\n/)) {
    const id = raw
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/^`|`$/g, '')
      .trim()
      .toLowerCase()
    if (!id || seen.has(id)) continue
    // `none` is the explicit "this design uses no foundational service" answer the guidance
    // asks for. It is a real, distinct outcome from an absent block (the agent never
    // answered), so it must not be recorded as an unknown service id.
    if (id === 'none') continue
    seen.add(id)
    if (knownIds.has(id)) declared.push(id)
    else unknown.push(id)
  }
  return { declared, unknown }
}

// --- agent-facing rendering ------------------------------------------------

/** The catalog projection the Architect designs against — identity, never a document body. */
export interface FoundationalCatalogView {
  id: string
  name: string
  summary: string
  description: string
  capabilities: string[]
  contracts: ApiContractSummary[]
  /**
   * The credentials a caller authenticates to this service WITH, by key name only, and only on a
   * service the DEPLOYMENT registered in code (a stored row may not declare any). The VALUES ride
   * the job body and never this projection, which is folded into prompts.
   *
   * Absent means the service declares none, which the briefs state as "no credential is supplied":
   * an unauthenticated service and one whose token the platform failed to deliver need opposite
   * reactions from an agent, and only the first is a fact about the service.
   */
  credentials?: CapabilityCredential[]
}

/**
 * The catalog as the renderer receives it. THREE outcomes, never two: a resolved catalog, a
 * resolved-but-empty one, and one that could not be READ at all.
 *
 * Discriminated rather than `FoundationalCatalogView[] | null` for the reason
 * `describeOwnService` is: the third state has to be impossible to forget. A nullable input
 * invites `services ?? []` at a new call site, which renders an outage as "none are
 * registered" — the one substitution this whole feature exists to prevent, and the one that
 * leaves no trace when it happens.
 */
export type FoundationalCatalogRead =
  | { status: 'resolved'; services: FoundationalCatalogView[] }
  /**
   * The catalog could not be read — on a mothership-mode node, typically the mothership being
   * unreachable or older than the node (see `ports/foundational-builtins.ts`). Carries no
   * services because none are KNOWN, which is precisely the point: what an outage produces is
   * ignorance, not an empty estate.
   */
  | { status: 'unavailable' }

/**
 * Render the catalog block folded into a design-time prompt. Deliberately compact: a name, a
 * one-line summary, the capability tags and each contract's format + operation names. The
 * DESCRIPTION is included because "when NOT to use this" is exactly the part a design step
 * needs, and it is the one field an author writes for this purpose.
 *
 * An EMPTY catalog renders as an explicit "none are registered" line rather than nothing —
 * an absent section and an empty one read identically to a model, and the difference is
 * whether "I found no shared service for this" was a finding or an omission. An UNREADABLE
 * one renders as a third thing again: "none are registered" is a fact an Architect may act on
 * by building the capability itself, and an outage is not that fact.
 */
export function renderFoundationalCatalog(read: FoundationalCatalogRead): string {
  if (read.status === 'unavailable') {
    return [
      "FOUNDATIONAL SERVICES: the catalog of this deployment's shared services COULD NOT BE READ, so it is unknown whether one already provides part of what this task asks for.",
      // Deliberately NOT phrased as "do not read this as <the empty-catalog sentence>": the
      // negated form still puts that sentence in the context, and a skimming model acts on the
      // clause, not the negation. State the uncertainty positively instead.
      'This deployment may well run shared services that this task should consume; their absence here is a platform failure, not evidence about the estate.',
      'Design so that a shared capability can be adopted later: keep any storage, notification, audit or auth concern behind a seam of its own rather than committing to a bespoke implementation of it, and state in your report that the foundational-service catalog was unavailable.',
    ].join('\n')
  }
  const services = read.services
  if (services.length === 0) {
    return 'FOUNDATIONAL SERVICES: none are registered for this workspace. Design the capability yourself, and say so.'
  }
  const lines: string[] = [
    'FOUNDATIONAL SERVICES available to this system (shared capabilities that already exist — prefer consuming one over building your own):',
    '',
  ]
  for (const service of services) {
    lines.push(`- id: ${service.id} — ${service.name}`)
    lines.push(`  ${service.summary}`)
    if (service.capabilities.length > 0) {
      lines.push(`  capabilities: ${service.capabilities.join(', ')}`)
    }
    if (service.description.trim()) {
      lines.push(`  ${service.description.trim().replace(/\r?\n/g, '\n  ')}`)
    }
    for (const contract of service.contracts) {
      lines.push(
        `  contract (${contract.format}): ${contract.title}${describeOperations(contract)}`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * The operation clause after one contract's line in the catalog.
 *
 * Three states, never two. An empty list from a format we DO read means the interface declares
 * nothing; an empty list from one we do not read means nobody looked, and saying so is what
 * stops an Architect concluding that a fully-specified service offers no endpoints. A partial
 * list always names how much of it is missing.
 */
function describeOperations(contract: ApiContractSummary): string {
  if (!operationsAreIndexable(contract.format)) {
    return ' — operations are not indexed for this format; read the contract document itself before naming an endpoint'
  }
  if (contract.operations.length === 0) {
    return contract.omittedOperations > 0
      ? ` — ${contract.omittedOperations} operations are declared in a form this platform could not read; read the contract document itself`
      : ' — declares no operations'
  }
  const omitted =
    contract.omittedOperations > 0
      ? ` (+${contract.omittedOperations} more operations not listed here)`
      : ''
  return ` — ${contract.operations.join(', ')}${omitted}`
}

/**
 * Render the ESTATE block an orientation-time kind reads: which services the organisation runs,
 * who owns each, and what interface each publishes.
 *
 * The same rows as {@link renderFoundationalCatalog} and a different document, because the reader
 * is doing a different job. A triage agent is not choosing a shared capability to build against;
 * it is trying to work out which service a report belongs to and who to route it to, and the
 * design framing ("prefer consuming one of these") would push it towards recommending an
 * adoption instead of naming a fault. So this states ownership first, asks for no declaration,
 * and says plainly what it does NOT carry: the full interface documents, which stay behind a
 * design's declaration because folding every one of them into every dispatch is the cost the
 * catalog/contracts split exists to avoid.
 *
 * The three-state input is the same one the catalog renderer takes, and for the same reason: an
 * estate that could not be READ must not render as an organisation that runs nothing, which is
 * exactly the substitution that would have a triage agent conclude a service does not exist.
 */
export function renderServiceEstate(read: FoundationalCatalogRead): string {
  if (read.status === 'unavailable') {
    return [
      "SERVICE ESTATE: the catalog of this organisation's services COULD NOT BE READ, so which services exist, who owns them and what they expose is unknown here.",
      'This is a platform failure, not evidence about the organisation. Do not conclude that a service you would expect does not exist, and do not attribute ownership from a name.',
      'Work from the repositories and code you can actually see, and state in your report that the service catalog was unavailable.',
    ].join('\n')
  }
  const services = read.services
  if (services.length === 0) {
    return [
      'SERVICE ESTATE: no service catalog is registered for this workspace, so the only services you can reason about are the ones whose code you have been given.',
      'Do not infer ownership or the existence of a neighbouring service from a name alone; if the work plainly crosses into a system you cannot see, say so in your report.',
    ].join('\n')
  }
  const lines: string[] = [
    'SERVICE ESTATE. These are the services this organisation runs, as its own catalog records them. Use the list to work out WHICH service a piece of work belongs to and WHO owns it:',
    '',
  ]
  for (const service of services) {
    lines.push(`- id: ${service.id} (${service.name})`)
    lines.push(`  ${service.summary}`)
    if (service.capabilities.length > 0) {
      lines.push(`  capabilities: ${service.capabilities.join(', ')}`)
    }
    if (service.description.trim()) {
      lines.push(`  ${service.description.trim().replace(/\r?\n/g, '\n  ')}`)
    }
    for (const contract of service.contracts) {
      lines.push(
        `  interface (${contract.format}): ${contract.title}${describeOperations(contract)}`,
      )
    }
    lines.push('')
  }
  lines.push(
    'The operation lists above are the interface SURFACE, not the full API documents: they are enough to say which service exposes what, and not enough to write a call against. Never invent an endpoint, a field or an owner that is not stated here, and if what you need is a service this list does not carry, say so rather than guessing at it.',
  )
  return lines.join('\n').trimEnd()
}

/** One contract document as the lazy read hands it downstream. */
export interface FoundationalContractBundle {
  id: string
  name: string
  summary: string
  description: string
  contracts: { contractId: string; format: ApiContractFormat; title: string; body: string }[]
  /** See {@link FoundationalCatalogView.credentials}: key names, never values. */
  credentials?: CapabilityCredential[]
}

/**
 * Render ONE service's contract documents as the body of its injected context file. Each
 * document is fenced with a language matching its format so the agent reads it as the
 * artifact it is, and an over-long body is cut with an explicit note naming how much was
 * dropped.
 */
export function renderContractDocument(bundle: FoundationalContractBundle): string {
  const lines: string[] = [
    `# ${bundle.name} (\`${bundle.id}\`)`,
    '',
    bundle.summary,
    '',
    bundle.description.trim(),
    '',
    ...renderServiceCredentials(bundle.credentials),
  ]
  for (const contract of bundle.contracts) {
    lines.push(`## ${contract.title} (${contract.format})`, '')
    const fence = contractFenceLanguage(contract.format)
    const { text, omitted } = capBody(contract.body)
    lines.push(`\`\`\`${fence}`, text, '```')
    if (omitted > 0) {
      lines.push(
        '',
        `> This document was truncated: ${omitted} characters of the original ${contract.body.length} are not shown. Treat the remainder as unread rather than absent.`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * The fence language one contract document is rendered under.
 *
 * Exhaustive over the format union with a `never` guard, so adding a format fails the BUILD here
 * rather than fencing a `.proto` file as TypeScript. The fence is not cosmetic: it is what tells
 * the agent which artifact it is reading, and a document fenced as the wrong language is one a
 * model will try to fix rather than call.
 */
function contractFenceLanguage(format: ApiContractFormat): string {
  switch (format) {
    case 'openapi':
    case 'asyncapi':
      // YAML's grammar is a superset of JSON's, so one fence serves a document stored as either.
      return 'yaml'
    case 'graphql':
      return 'graphql'
    case 'grpc':
      return 'proto'
    case 'toad-contract':
    case 'lokalise-api-contract':
      return 'ts'
    default:
      return exhaustiveContractFormat(format)
  }
}

/** The compile-time totality guard for {@link contractFenceLanguage}. */
function exhaustiveContractFormat(format: never): string {
  return String(format)
}

function capBody(body: string): { text: string; omitted: number } {
  if (body.length <= MAX_CONTRACT_BODY_CHARS) return { text: body, omitted: 0 }
  return {
    text: body.slice(0, MAX_CONTRACT_BODY_CHARS),
    omitted: body.length - MAX_CONTRACT_BODY_CHARS,
  }
}

/**
 * What the index file has to report. Discriminated for the same reason
 * {@link FoundationalCatalogRead} is: a read that FAILED knows none of `bundles` / `unknown` /
 * `noDeclaration`, and expressing it by passing empties would render an outage as the design
 * having declared nothing — the state an implementer is entitled to act on.
 */
export type FoundationalIndexRead =
  | {
      status: 'resolved'
      bundles: FoundationalContractBundle[]
      unknown: string[]
      /** True when no design step declared anything (skipped, or ran before this feature). */
      noDeclaration: boolean
    }
  | { status: 'unavailable' }

/**
 * Render the index file that accompanies the injected documents — WHAT was injected, and
 * (the load-bearing half) what the design declared that could NOT be. An id the Architect
 * named but the catalog does not know, an architect step that never ran at all, and a catalog
 * that could not be read are different failures needing different fixes, and none of them may
 * render as "no foundational services are involved".
 */
export function renderFoundationalIndex(input: FoundationalIndexRead): string {
  const lines: string[] = ['# Foundational services for this task', '']
  if (input.status === 'unavailable') {
    lines.push(
      "The catalog of this deployment's shared services could not be read, so the API contracts this task's design declared are NOT available here.",
      'What the design chose is unknown, not empty — this says nothing about whether a shared service applies.',
      'Do not guess at the API of a shared service. Implement what you can without it, leave the integration point behind a seam, and state in your report that the foundational-service contracts were unavailable.',
    )
    return lines.join('\n').trimEnd()
  }
  if (input.noDeclaration) {
    lines.push(
      'No design step declared any foundational service for this task (the design step did not run, or declared none).',
      'Do not infer from this that no shared service applies — nothing was checked. If your work needs a shared capability, say so in your report.',
      '',
    )
  }
  if (input.bundles.length > 0) {
    lines.push(
      'The design declared the services below. Their API contracts are in this directory — treat them as the authoritative interface and do not invent endpoints:',
      '',
    )
    for (const bundle of input.bundles) {
      lines.push(
        `- \`${bundle.id}\` — ${bundle.name}: ${bundle.summary} (see \`${contextFileFor(bundle.id)}\`)`,
      )
    }
    lines.push('')
  } else if (!input.noDeclaration) {
    lines.push('The design declared no foundational services for this task.', '')
  }
  if (input.unknown.length > 0) {
    lines.push(
      `The design also named ${input.unknown.join(', ')}, which the catalog does not contain — no contract is available for ${input.unknown.length === 1 ? 'it' : 'them'}. Do not guess at ${input.unknown.length === 1 ? 'its' : 'their'} API; raise it instead.`,
      '',
    )
  }
  return lines.join('\n').trimEnd()
}

/**
 * How to AUTHENTICATE to a service, as lines folded into whatever surface describes it.
 *
 * The one place that sentence is written, because two surfaces state it (a consumer's injected
 * contract document and a binary-output step's storage brief) and both must name the SAME variable
 * the dispatch resolver sets. The name comes from `credentialInjectionName`, the same helper the
 * resolver keys the job body with, so the two cannot drift into naming different variables.
 *
 * A service that declares NONE renders nothing at all here, deliberately: it is the ordinary case
 * (an internal service on a trusted network, a contract that carries its own auth story in prose),
 * and a line saying "this needs no credential" on every one of them would be noise that trains an
 * agent to skip the section on the service where it matters.
 *
 * What is NOT said here is whether the value actually resolved. The agent can SEE whether the
 * variable is set, and an unset one already means "the platform could not provide it" everywhere
 * else on this seam; a second claim from the prompt side could only agree with the environment or
 * contradict it.
 */
export function renderServiceCredentials(
  credentials: readonly CapabilityCredential[] | undefined,
): string[] {
  if (!credentials?.length) return []
  const lines = [
    credentials.length === 1
      ? 'Authenticate to it with the credential the platform supplies in this environment variable:'
      : 'Authenticate to it with the credentials the platform supplies in these environment variables:',
  ]
  for (const credential of credentials) {
    const name = credentialInjectionName(credential)
    const usage = credential.usage ? ` — ${credential.usage}` : ''
    const optional = credential.required === false ? ' (optional)' : ''
    lines.push(`- \`$${name}\`${optional}${usage}`)
  }
  lines.push(
    'An UNSET variable means the platform could not provide that credential: report the gap rather than calling the service unauthenticated or inventing a token.',
    '',
  )
  return lines
}

/**
 * The DISPATCH projection of one foundational service's credentials: the ids and the two NAMES per
 * credential, never a value.
 *
 * The twin of `ResolvedBinaryGenerator`, and a shape of its own for the same reason: the container
 * executor rebuilds a dispatch from the run context alone, with neither the catalog nor the step
 * to look a definition up in. Narrower than {@link CapabilityCredential} because the prose fields
 * (`usage`) are the BRIEF's business, and a second copy of them on the wire would be text nothing
 * reads and a future reader could believe was authoritative.
 */
export interface ResolvedServiceCredentials {
  id: string
  /** The service's display name, for the log line when a credential does not resolve. */
  name: string
  /** In declaration order; never empty (a service declaring none is omitted from the set). */
  credentials: ResolvedServiceCredential[]
}

/** One credential on the dispatch projection: both names plus the disposition. */
export interface ResolvedServiceCredential {
  /** The LOOKUP key the executor asks the resolver for. */
  key: string
  /** The variable the value is injected as, when it differs from {@link key}. */
  envName?: string
  /** Whether a missing value means the service must not be called (defaults true). */
  required?: boolean
}

/**
 * Project the services a dispatch was briefed on down to the ones that declare a credential.
 *
 * Here rather than at the call site because two different id sets reach it (a binary-output
 * step's selection, a consumer kind's declared set) and both must produce the same shape from the
 * same catalog: a projection built twice is two places for the injection-name fallback to drift
 * from the brief that names it.
 */
export function dispatchServiceCredentials(
  services: readonly FoundationalCatalogView[],
): ResolvedServiceCredentials[] {
  const projected: ResolvedServiceCredentials[] = []
  for (const service of services) {
    const credentials = (service.credentials ?? []).map((credential) => ({
      key: credential.key,
      ...(credential.envName ? { envName: credential.envName } : {}),
      ...(credential.required === false ? { required: false } : {}),
    }))
    if (credentials.length) projected.push({ id: service.id, name: service.name, credentials })
  }
  return projected
}

/** The `.cat-context/` path one service's contract bundle is injected at. */
export function contextFileFor(serviceId: string): string {
  return `${FOUNDATIONAL_CONTEXT_DIR}/${serviceId}.md`
}
