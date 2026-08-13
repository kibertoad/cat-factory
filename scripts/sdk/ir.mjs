// `docs/openapi.json` → a language-neutral IR the four SDK emitters render from.
//
// The spec is the ONE source of truth for every SDK (it is itself generated from the Valibot
// route contracts by `scripts/generate-openapi.mjs`), so a public-API contract change flows
// contracts → spec → four SDKs with no hand-editing anywhere in the chain. This module owns
// everything that is a property of the SURFACE rather than of a language: which types exist,
// what they are called, what is nullable vs absent, and which operation reaches which of them.
// An emitter then only decides how to SPELL that in its language.
//
// Three things here are load-bearing beyond "walk the JSON":
//
//   1. **Inline schemas get stable, structural names.** Valibot inlines most of the surface —
//      only ~29 DTOs are hoisted into `components.schemas`, and the whole `/api/v1/debug/*`
//      surface is anonymous. A typed language needs a name for each, and that name is part of
//      the SDK's public API, so it may not shift when an unrelated endpoint is added. Names are
//      therefore derived from the shape's POSITION (parent + property path) and then collapsed
//      by STRUCTURE: two positions carrying the identical shape resolve to one type. Without
//      the collapse the debug surface alone would emit ~15 copies of the same `DebugText`.
//   2. **A recurring shape may be NAMED explicitly** in {@link INLINE_TYPE_NAMES}, keyed by its
//      property signature. Positional naming is correct but ugly for a shape that appears in
//      twelve places (`GetDebugAgentContextResponseContextFileContent` for what is just a
//      windowed text body), and these names are what a user reads. Two different shapes
//      claiming one name FAILS generation rather than silently merging.
//   3. **"Nullable" and "optional" stay apart.** `anyOf [X, null]` is a field that is always
//      PRESENT and may hold null; absence from `required` is a field that may not be sent at
//      all. The distinction survives into every emitter, because collapsing them is exactly the
//      "absent ≠ zero" failure the platform's own degrade-loudly rule is about — a caller that
//      cannot tell "the server said null" from "the server said nothing" cannot report either.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OPENAPI_PATH = resolve(repoRoot, 'docs/openapi.json')

/**
 * Explicit names for recurring inline shapes, keyed by the shape's SIGNATURE: its property
 * names, sorted, comma-joined. Positional naming (the fallback) is deterministic but reads
 * badly for a shape that recurs — and these names ship in four public SDKs, so they are worth
 * choosing rather than deriving.
 *
 * A signature listed here that matches nothing in the spec is a stale entry and fails
 * generation, exactly like a name two distinct shapes both claim: both mean the spec moved
 * under the table and someone has to look.
 */
const INLINE_TYPE_NAMES = {
  'chars,matchOffset,offset,text,totalChars,truncated': 'DebugText',
  'completed,inProgress,total': 'RunSubtaskCounts',
  'completed,inProgress,items,total': 'DebugSubtaskCounts',
  'label,status': 'DebugSubtaskItem',
  'detail,hint,kind,lastSubtasks,message,occurredAt,reason,stepIndex': 'DebugRunFailure',
  'branch,url': 'RunPullRequest',
  'code,message': 'RunError',
  // The judge park is the one `PublicDecision` variant the spec inlines rather than hoisting,
  // so positional naming would ship it as `PublicDecisionVariant2` — a name that renumbers if
  // a variant is ever added ahead of it.
  'bounces,kind,maxBounces,rubricId,rubricName,status,stepKind,threshold,verdict':
    'PublicJudgeDecision',
  'findings,score,summary': 'PublicJudgeVerdict',
  'detail,severity,title,where': 'PublicJudgeFinding',
  'choice,feedback': 'PublicResolveJudge',
  // The debug reads: each of these is BOTH a list item and a single-read response, and the
  // collapse resolves them to one type — so the name has to read correctly in both places.
  'agentKind,cacheReadTokens,cacheWriteTokens,callId,completionTokens,createdAt,elidedLeadingMessages,errorMessage,finishReason,httpStatus,messageCount,model,ok,outcome,overheadMs,phase,prompt,promptMessages,promptTokens,provider,reasoning,requestMaxTokens,response,runId,streaming,toolCount,totalMs,totalTokens,turnIndex,upstreamMs':
    'DebugLlmCall',
  'agentKind,contextFiles,createdAt,extras,fragments,harness,model,runId,snapshotId,stepIndex,systemPrompt,userPrompt':
    'DebugAgentContextSnapshot',
  'content,path,title,url': 'DebugContextFile',
  'body,id': 'DebugContextFragment',
  'content,index,name,role,toolCallId,toolCalls': 'DebugPromptMessage',
  'args,name': 'DebugToolCall',
  'diagnostics,generatedAt,kind,llm,run,signals,sinks,steps,toolCalls,version': 'DebugRunOverview',
  'blockId,createdAt,currentStep,failure,pipelineId,pipelineName,runId,status,stepCount':
    'DebugRunSummary',
  'agentKind,contextFilesChars,createdAt,fragmentsChars,harness,model,snapshotId,stepIndex,systemPromptChars,userPromptChars':
    'DebugAgentContextSummary',
  'blockId,createdAt,detail,error,executionId,id,operation,outcome,providerId,subsystem,targetId,workspaceId':
    'DebugInfraLogEntry',
  'agentKind,createdAt,executionId,id,provider,query,resultCount,workspaceId': 'DebugSearchQuery',
  'agentKind,branchContentionRecoveries,evictionRecoveries,finishedAt,firstEvictionDetail,hasStructuredResult,index,lastActivityAt,model,outputChars,progress,skipped,startedAt,state,subtasks,toolServers':
    'DebugRunStep',
  'agentKind,observed,unavailable,wired': 'DebugStepToolServers',
  'id,label,tools,transport': 'DebugWiredToolServer',
  'id,label,reason': 'DebugUnavailableToolServer',
  'id,status,toolCount': 'DebugObservedToolServer',
  'agentKind,code,count,message,severity,stepIndex': 'DebugRunSignal',
  'agentKind,cacheHitRate,cacheReadTokens,cacheWriteTokens,calls,completionTokens,costEstimate,errors,maxOutputTokens,outputHeadroomRatio,overheadMs,peakCompletionTokens,promptTokens,transportOverheadRatio,truncatedCalls,upstreamMs,warnings':
    'DebugLlmAgentKindRollup',
  'cacheHitRate,cacheReadTokens,cacheWriteTokens,calls,carryCostShare,carryCostTokens,completionTokens,costEstimate,errors,overheadMs,phase,promptTokens,truncatedCalls,upstreamMs,warnings':
    'DebugLlmPhaseRollup',
  'cacheHitRate,cacheReadTokens,cacheWriteTokens,calls,completionTokens,costEstimate,errors,overheadMs,promptTokens,transportOverheadRatio,truncatedCalls,upstreamMs,warnings':
    'DebugLlmTotals',
  // The tool-EXECUTION rollup, cut the same three ways as the LLM one above it.
  'calls,failureRate,failures': 'DebugToolCallTotals',
  'calls,failureRate,failures,tool': 'DebugToolRollup',
  'agentKind,calls,failureRate,failures': 'DebugToolCallKindRollup',
}

/** Enum value-sets that deserve a chosen name rather than a positional one. */
const INLINE_ENUM_NAMES = {
  'blocked,done,in_progress,planned,pr_ready,ready': 'TaskStatus',
  'blocked,done,failed,paused,running': 'RunStatus',
  'done,pending,waiting_decision,working': 'StepState',
  'critical,high,low,medium': 'Severity',
  'error,ok,warning': 'LlmCallOutcome',
  // The iterative-review lifecycle, shared verbatim by the requirements review, the clarity
  // review and both brainstorm dialogues (the engine drives all three through one controller, so
  // the contracts alias one picklist). The name is PINNED because the requirements decision
  // shipped first and published it: without this the deduped enum would take whichever variant
  // member the walk reached first, silently RENAMING a type in four released SDKs — a break
  // `/api/v1` does not do, and one that would arrive as a clean diff nobody read.
  'exceeded,incorporated,incorporating,merged,ready,reviewing': 'PublicRequirementsDecisionStatus',
  // The spend breakdown's three vocabularies. Pinned for the reason stated above rather than left
  // to the positional hint: unnamed they take the first path that reaches them
  // (`GetPublicSpendWindow`, `GetPublicSpendResponseSource`), so a later operation sharing a value
  // set would RENAME a type in four released SDKs, arriving as a clean generated diff nobody
  // reads. The window and the source are ordinary enough sets for that to be a matter of time.
  // A service's role on the board, shared verbatim by `POST /api/v1/services` and the repo
  // bootstrap that CREATES one. Pinned on exactly the precedent above: the service creation route
  // shipped first and published this name, and the bootstrap operation is walked first, so
  // unpinned the deduped enum renames a type in four released SDKs (the Java model file moves,
  // every Go constant is respelled) while the diff looks like ordinary generated churn.
  'document,frontend,library,service': 'CreatePublicServiceRequestType',
  '24h,30d,7d,90d': 'PublicSpendWindow',
  'daily-rollup,ledger': 'PublicSpendSource',
  'agentKind,model,repo,run,service,taskType,ticket': 'PublicSpendDimension',
}

/** OpenAPI/JSON-Schema scalar → IR primitive. */
const PRIMITIVES = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
}

/** Irregular plurals are not worth a library; the spec's array properties are all regular. */
function singular(name) {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`
  if (name.endsWith('sses') || name.endsWith('shes') || name.endsWith('ches')) {
    return name.slice(0, -2)
  }
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1)
  return name
}

export function pascal(text) {
  return String(text)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

export function camel(text) {
  const p = pascal(text)
  return p.charAt(0).toLowerCase() + p.slice(1)
}

export function snake(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
}

/** A stable, order-independent signature for an object shape (its property names). */
function objectSignature(schema) {
  return Object.keys(schema.properties ?? {})
    .sort()
    .join(',')
}

/** A stable signature for an enum (its values). */
function enumSignature(values) {
  return [...values].sort().join(',')
}

/**
 * A structural fingerprint used to COLLAPSE two identically-shaped inline schemas onto one
 * emitted type. Key-sorted so property order in the spec cannot split a type in two, and it
 * covers the whole subtree — two shapes that differ only in a nested field stay distinct.
 */
function fingerprint(node) {
  if (Array.isArray(node)) return `[${node.map(fingerprint).join(',')}]`
  if (node && typeof node === 'object') {
    return `{${Object.keys(node)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${fingerprint(node[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(node)
}

/**
 * Walks the document, resolving every schema to a {@link TypeRef} and registering the named
 * object/enum/union types it discovers along the way.
 */
class TypeRegistry {
  constructor(components) {
    this.components = components
    /** name → type definition, in discovery order. */
    this.types = new Map()
    /** structural fingerprint → the name it resolved to (the collapse table). */
    this.byFingerprint = new Map()
    /** Explicit-name tables, consumed as they are hit so a stale entry is detectable. */
    this.unusedObjectNames = new Set(Object.keys(INLINE_TYPE_NAMES))
    this.unusedEnumNames = new Set(Object.keys(INLINE_ENUM_NAMES))
  }

  /** Register a type under `name`, refusing a second, structurally different claim on it. */
  define(name, def, fp) {
    const existing = this.types.get(name)
    if (existing) {
      if (existing.fingerprint !== fp) {
        throw new Error(
          `SDK IR: two structurally different schemas both resolve to the type name '${name}'. ` +
            'Give one of them an explicit name in INLINE_TYPE_NAMES (scripts/sdk/ir.mjs).',
        )
      }
      return name
    }
    this.types.set(name, { ...def, name, fingerprint: fp })
    this.byFingerprint.set(fp, name)
    return name
  }

  /**
   * Resolve a schema to a TypeRef, minting named types for the inline objects/enums/unions it
   * contains. `hint` is the positional name candidate (parent + property path).
   */
  resolve(schema, hint) {
    if (!schema || Object.keys(schema).length === 0) return { kind: 'unknown' }
    if (schema.$ref) return { kind: 'ref', name: schema.$ref.replace('#/components/schemas/', '') }
    if (schema.const !== undefined) return { kind: 'const', value: schema.const }

    if (Array.isArray(schema.oneOf)) return this.resolveUnion(schema, hint, schema.oneOf)
    if (Array.isArray(schema.anyOf)) return this.resolveAnyOf(schema, hint)

    if (schema.type === 'array') {
      return { kind: 'array', items: this.resolve(schema.items, singular(hint)) }
    }
    if (schema.type === 'object' || schema.properties) {
      if (schema.properties) return { kind: 'ref', name: this.defineObject(schema, hint) }
      // `additionalProperties` with no declared properties: an open string-keyed map.
      return {
        kind: 'map',
        values: this.resolve(
          typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {},
          `${hint}Value`,
        ),
      }
    }
    if (Array.isArray(schema.enum) && schema.type === 'string') {
      return { kind: 'ref', name: this.defineEnum(schema.enum, hint) }
    }
    const primitive = PRIMITIVES[schema.type]
    if (primitive) {
      return { kind: primitive, format: schema.pattern ? 'pattern' : undefined }
    }
    return { kind: 'unknown' }
  }

  /**
   * `anyOf` carries two very different intents in this spec and they must not be conflated:
   * `[X, null]` is X-that-may-be-null, while a set of string members (an enum PLUS a `pattern`
   * escape hatch — the open `taskType` vocabulary) is an OPEN string, where narrowing to the
   * closed enum would make the SDK reject values the server accepts.
   */
  resolveAnyOf(schema, hint) {
    const members = schema.anyOf.filter((m) => m.type !== 'null')
    const nullable = members.length !== schema.anyOf.length
    if (members.length === 0) return { kind: 'unknown', nullable }
    if (members.length === 1) return { ...this.resolve(members[0], hint), nullable }
    if (members.every((m) => m.type === 'string')) {
      const closed = members.find((m) => Array.isArray(m.enum))
      return { kind: 'string', open: true, suggestedValues: closed?.enum ?? [], nullable }
    }
    return { ...this.resolveUnion(schema, hint, members), nullable }
  }

  /** A tagged union (`oneOf`). Discriminated when every variant carries the same `const` field. */
  resolveUnion(schema, hint, variants) {
    const refs = variants.map((variant, index) => this.resolve(variant, `${hint}Variant${index}`))
    const fp = fingerprint({ union: variants })
    const collapsed = this.byFingerprint.get(fp)
    if (collapsed) return { kind: 'ref', name: collapsed }
    const name = pascal(hint)
    return {
      kind: 'ref',
      name: this.define(
        name,
        { kind: 'union', variants: refs, discriminator: this.discriminatorOf(variants, refs) },
        fp,
      ),
    }
  }

  /** The property every variant pins to a distinct `const`, if there is exactly one such. */
  discriminatorOf(variants, refs) {
    const resolved = variants.map((variant, index) =>
      variant.$ref || refs[index].kind === 'ref'
        ? (this.types.get(refs[index].name)?.source ?? this.componentSource(variant))
        : variant,
    )
    if (resolved.some((v) => !v?.properties)) return null
    const candidates = Object.keys(resolved[0].properties).filter((key) =>
      resolved.every((v) => v.properties[key]?.const !== undefined),
    )
    if (candidates.length !== 1) return null
    return {
      property: candidates[0],
      values: resolved.map((v) => v.properties[candidates[0]].const),
    }
  }

  /** The raw component schema behind a `$ref` (used to inspect a union variant's discriminator). */
  componentSource(schema) {
    if (!schema?.$ref) return schema
    return this.components[schema.$ref.replace('#/components/schemas/', '')]
  }

  defineObject(schema, hint) {
    const fp = fingerprint(schema)
    const collapsed = this.byFingerprint.get(fp)
    if (collapsed) return collapsed
    const signature = objectSignature(schema)
    const chosen = INLINE_TYPE_NAMES[signature]
    if (chosen) this.unusedObjectNames.delete(signature)
    const name = chosen ?? pascal(hint)
    // Reserve the name BEFORE resolving fields: a self-referential shape would otherwise
    // recurse forever, and a sibling field would race it into the collapse table.
    this.types.set(name, { kind: 'object', name, fields: [], fingerprint: fp, source: schema })
    this.byFingerprint.set(fp, name)
    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties ?? {}).map(([wireName, propSchema]) => {
      const type = this.resolve(propSchema, `${name}${pascal(wireName)}`)
      // A property carrying a DEFAULT is absent from `required` — the caller may omit it — but it
      // is ALWAYS PRESENT in what the server sends back, because the default is applied on the way
      // out. For a response model, emitting it optional is simply wrong: it makes a caller
      // null-check a field that cannot be absent, and it disagrees with the contract's own
      // inferred output type. `assertNoDefaultedRequestField` below guarantees this reading is the
      // right one by refusing to generate if such a property ever appears in a REQUEST body, where
      // the opposite (optional) is correct.
      const hasDefault = propSchema.default !== undefined
      return {
        wireName,
        type,
        required: required.has(wireName) || hasDefault,
        hasDefault,
        nullable: type.nullable === true,
        doc: propSchema.description,
        constraints: {
          minimum: propSchema.minimum,
          maximum: propSchema.maximum,
          minLength: propSchema.minLength,
          maxLength: propSchema.maxLength,
          pattern: propSchema.pattern,
        },
      }
    })
    this.types.get(name).fields = fields
    return name
  }

  /**
   * Whether a resolved REQUEST-BODY ref names an object every one of whose fields may be omitted,
   * so `{}` is already a complete request and a caller has nothing it MUST say.
   *
   * Read off the resolved type rather than declared per operation: "the spec marks no property
   * required" is a fact the document already states, and a hand-kept list of which operations
   * have all-optional bodies would be one contract edit away from disagreeing with it.
   *
   * The reading is only sound for a REQUEST body, which is why nothing else calls this: a field
   * carrying a `default` is recorded `required` (the server always sends it back), and
   * {@link assertNoDefaultedRequestField} is what guarantees no request body contains one.
   */
  allOptionalObject(ref) {
    if (ref?.kind !== 'ref') return false
    const type = this.types.get(ref.name)
    return type?.kind === 'object' && type.fields.every((field) => !field.required)
  }

  defineEnum(values, hint) {
    const signature = enumSignature(values)
    const chosen = INLINE_ENUM_NAMES[signature]
    if (chosen) this.unusedEnumNames.delete(signature)
    const existing = [...this.types.values()].find(
      (t) => t.kind === 'enum' && enumSignature(t.values) === signature,
    )
    if (existing) return existing.name
    const name = chosen ?? pascal(hint)
    return this.define(name, { kind: 'enum', values }, `enum:${signature}`)
  }
}

/** Media type of an operation's success response, and the schema behind it. */
function successResponse(operation) {
  const codes = Object.keys(operation.responses ?? {}).filter((c) => /^2\d\d$/.test(c))
  if (codes.length === 0) return { status: 204, mediaTypes: [], schema: null }
  const status = Number(codes.sort()[0])
  const content = operation.responses[String(status)].content ?? {}
  // ALL of them, not the first key: a response that can answer with several media types (the
  // artifact blob serves any of four image types) is classified by what the SET means. Reading
  // one key made the emitted return type depend on the order the generator happened to write the
  // content map in, which is a property no one would think to preserve while editing it.
  return { status, mediaTypes: Object.keys(content), schema: content['application/json']?.schema }
}

/**
 * How an operation's success body is handed back: a typed value, an event reader, raw bytes, or
 * nothing. The emitters branch on exactly this, so the decision is made ONCE here rather than
 * re-derived from media-type strings in four languages.
 *
 * JSON mixed with anything else THROWS rather than picking a side: a body that is sometimes a
 * value and sometimes bytes has no honest single return type in any of the four clients, and
 * silently choosing one is how a caller ends up with a `Uint8Array` where its code expects a
 * parsed object. Every remaining media type is bytes, vetted by {@link assertKnownResponseMedia}
 * first, so "bytes" is a decision about a type someone deliberately allowed, never a fallback
 * that swallowed a typo.
 */
function responseKind(operationId, { mediaTypes }) {
  if (mediaTypes.length === 0) return 'empty'
  const json = mediaTypes.includes('application/json')
  if (json && mediaTypes.length > 1) {
    throw new Error(
      `SDK IR: ${operationId} answers success with JSON and ${mediaTypes
        .filter((m) => m !== 'application/json')
        .join(', ')}. Split it into two operations, or drop one: a single method cannot return ` +
        'both a parsed value and an opaque body.',
    )
  }
  if (json) return 'json'
  if (mediaTypes.includes('text/event-stream')) return 'stream'
  return 'binary'
}

/**
 * Build the IR from the committed OpenAPI document.
 *
 * @param {object} [doc] the parsed spec; read from `docs/openapi.json` when omitted.
 */
export async function buildIr(doc) {
  const spec = doc ?? JSON.parse(await readFile(OPENAPI_PATH, 'utf8'))
  const components = spec.components?.schemas ?? {}
  const registry = new TypeRegistry(components)

  // Hoisted DTOs first, so a component name always wins over a positional one and the
  // emitted type set is stable against endpoints being added around it.
  for (const [name, schema] of Object.entries(components)) {
    if (schema.oneOf) {
      registry.define(
        name,
        {
          kind: 'union',
          variants: schema.oneOf.map((v, i) => registry.resolve(v, `${name}Variant${i}`)),
          discriminator: registry.discriminatorOf(
            schema.oneOf,
            schema.oneOf.map((v, i) => registry.resolve(v, `${name}Variant${i}`)),
          ),
        },
        fingerprint(schema),
      )
    } else {
      registry.defineObject(schema, name)
    }
  }

  // Before anything is classified: an unvetted media type must fail by NAME here, rather than be
  // binned as "bytes" by `responseKind` and surface later as a client that hands back a blob.
  assertKnownResponseMedia(spec)

  const operations = []
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const id = operation.operationId
      const params = operation.parameters ?? []
      const success = successResponse(operation)
      const kind = responseKind(id, success)
      const bodySchema = operation.requestBody?.content?.['application/json']?.schema
      // The key-scope floor the route enforces, stamped by `generate-openapi.mjs` from each
      // contract's `minScope`. Required rather than defaulted: an operation with no floor would
      // ship in the gatekeeper bindings as policy metadata that silently says nothing, and the
      // generator upstream already refuses to produce such a spec.
      const body = bodySchema ? registry.resolve(bodySchema, `${pascal(id)}Request`) : null
      const minScope = operation['x-min-scope']
      if (typeof minScope !== 'string') {
        throw new Error(
          `SDK IR: ${id} (${method.toUpperCase()} ${path}) carries no x-min-scope. Regenerate the ` +
            'spec (`pnpm gen:openapi`); a public contract without `withMinScope` fails there.',
        )
      }
      operations.push({
        id,
        minScope,
        // `httpMethod`, not `method`: the SDK surface table (scripts/sdk/surface.mjs) names each
        // operation's METHOD on its resource client, and one of the two had to give.
        httpMethod: method.toUpperCase(),
        path,
        tag: operation.tags?.[0] ?? 'Public API',
        summary: operation.summary ?? id,
        description: operation.description ?? '',
        pathParams: params
          .filter((p) => p.in === 'path')
          .map((p) => ({ wireName: p.name, doc: p.description })),
        queryParams: params
          .filter((p) => p.in === 'query')
          .map((p) => ({
            wireName: p.name,
            required: p.required === true,
            type: registry.resolve(p.schema, `${pascal(id)}${pascal(p.name)}`),
            doc: p.description,
          })),
        body,
        /**
         * The body carries no required field, so a caller with nothing to say may omit it and
         * every client fills in `{}`. It is a CLIENT-side fact, never a wire one: the request
         * body itself stays required (the route's validator rejects an absent one), and what
         * changes is only whether the caller has to type an empty object to satisfy it.
         */
        bodyOptional: registry.allOptionalObject(body),
        // A stream is not a value: the SSE operations hand back a reader, so an emitter must
        // branch on this rather than trying to decode `text/event-stream` as the result type.
        stream: kind === 'stream',
        // Neither is a blob: the artifact download hands back raw bytes.
        binary: kind === 'binary',
        status: success.status,
        result: kind === 'json' ? registry.resolve(success.schema, `${pascal(id)}Response`) : null,
      })
    }
  }
  operations.sort((a, b) => a.id.localeCompare(b.id))

  assertNoDefaultedRequestField(registry, operations)

  if (registry.unusedObjectNames.size > 0 || registry.unusedEnumNames.size > 0) {
    throw new Error(
      'SDK IR: stale explicit names in scripts/sdk/ir.mjs — no schema in the spec has the ' +
        `signature(s): ${[...registry.unusedObjectNames, ...registry.unusedEnumNames].join(' | ')}`,
    )
  }

  // The scope vocabulary the per-operation floors are drawn from, ordered least to greatest, as
  // `generate-openapi.mjs` stamps it from the contracts' `PUBLIC_API_SCOPES`. Required rather
  // than defaulted, for the reason `x-min-scope` is: an emitter that fell back to a restated copy
  // would rank a key against a ladder the deployment may have moved past, and the failure is
  // SILENT (an unknown rung ranks -1, so every capability filters out and the caller sees a key
  // with no permissions rather than an error).
  const scopeLadder = spec['x-public-api-scopes']
  if (!Array.isArray(scopeLadder) || scopeLadder.length === 0) {
    throw new Error(
      'SDK IR: the spec carries no x-public-api-scopes ladder. Regenerate it (`pnpm gen:openapi`).',
    )
  }

  return {
    info: spec.info,
    scopeLadder,
    security: spec.components?.securitySchemes ?? {},
    tags: spec.tags ?? [],
    types: [...registry.types.values()]
      .map(({ source: _source, fingerprint: _fp, ...rest }) => rest)
      .sort((a, b) => a.name.localeCompare(b.name)),
    operations,
  }
}

/**
 * Refuse to generate if a REQUEST body reaches a property carrying a `default`.
 *
 * `defineObject` reads a default as "always present", which is right for a response and wrong for
 * a request: on the way IN the caller may omit the field, and marking it required would force
 * every caller to supply a value the server would have chosen for them. No request body has one
 * today, so rather than build machinery to model a type that is both — and quietly pick a side —
 * this fails loudly the day it happens, and whoever adds it decides.
 */
/**
 * Refuse to generate against a success media type nobody has decided how to hand back.
 *
 * The emitters branch three ways: JSON decodes into the result type, `text/event-stream` hands
 * back a reader, and everything else hands back bytes. That last clause is why this allow-list
 * still earns its keep after `responseKind` stopped needing it to be exhaustive: without it a
 * media type nobody intended (a typo, a `text/csv` somebody expected to arrive as a string)
 * quietly becomes an opaque blob in four published clients, which reads to a caller as the
 * platform's answer rather than as the oversight it is. Listing a type here is the decision that
 * bytes are what that endpoint should hand back.
 *
 * Checked over the SPEC rather than the IR, because by the time an operation is in the IR the
 * media types it carried have been collapsed into one flag.
 */
function assertKnownResponseMedia(spec) {
  const known = new Set([
    'application/json',
    'text/event-stream',
    // Bytes. The image types are what the artifact-blob route clamps a stored content type to;
    // octet-stream is its fallback for a row it does not recognise. Kept in step with the server
    // by `blobMediaTypes.spec.ts`, which pins the SPEC's set to the allow-list itself.
    'application/octet-stream',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ])
  const successMedia = (operation) =>
    Object.entries(operation.responses ?? {})
      .filter(([code]) => /^2\d\d$/.test(code))
      .flatMap(([, response]) => Object.keys(response.content ?? {}))
  const offenders = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).flatMap(([method, operation]) =>
      successMedia(operation)
        .filter((media) => !known.has(media))
        .map((media) => `${method.toUpperCase()} ${path} -> ${media}`),
    ),
  )
  if (offenders.length > 0) {
    throw new Error(
      `SDK IR: success response media type(s) no emitter can return: ${offenders.join(', ')}. ` +
        'Teach every transport how to hand the body back (see the `binary` flag) rather than ' +
        'letting the operation generate as a method that discards it.',
    )
  }
}

function assertNoDefaultedRequestField(registry, operations) {
  const reachable = new Set()
  const visit = (ref) => {
    if (!ref) return
    if (ref.kind === 'array') return visit(ref.items)
    if (ref.kind === 'map') return visit(ref.values)
    if (ref.kind !== 'ref' || reachable.has(ref.name)) return
    reachable.add(ref.name)
    const type = registry.types.get(ref.name)
    if (!type) return
    for (const field of type.fields ?? []) visit(field.type)
    for (const variant of type.variants ?? []) visit(variant)
  }
  for (const operation of operations) visit(operation.body)

  const offenders = []
  for (const name of reachable) {
    for (const field of registry.types.get(name)?.fields ?? []) {
      if (field.hasDefault) offenders.push(`${name}.${field.wireName}`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `SDK IR: ${offenders.join(', ')} carry a \`default\` and are reachable from a REQUEST body. ` +
        'A default means "always present" on the way OUT but "may be omitted" on the way IN, and ' +
        'the emitters currently assume the former. Decide explicitly in scripts/sdk/ir.mjs.',
    )
  }
}
