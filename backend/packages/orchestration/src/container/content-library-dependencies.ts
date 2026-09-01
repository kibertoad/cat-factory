import type {
  AgentKindSource,
  ResolveFragmentInstallationId,
  ResolveSkillInstallationId,
} from '@cat-factory/agents'
import type {
  AccountSkillRepository,
  ApiContractRepository,
  AppCaches,
  BinaryGeneratorRegistry,
  BinaryGeneratorSource,
  BinaryStoreRegistry,
  DeploymentDocumentResolver,
  DocumentContentResolver,
  FoundationalBuiltinSource,
  FoundationalServiceRegistry,
  FoundationalServiceRepository,
  FoundationalServiceSourceRepository,
  FoundationalSourceResyncRequest,
  FragmentBriefGenerator,
  FragmentBriefRepository,
  FragmentSelector,
  FragmentSourceRepository,
  PromptFragmentRegistry,
  PromptFragmentRepository,
  PromptFragmentSource,
  SecretCipher,
  ServiceCatalogConnectionRepository,
  SkillSourceRepository,
  SkillSourceResyncRequest,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'

// The CONTENT-LIBRARY half of `CoreDependencies`: the prompt-fragment library, the repo-sourced
// Claude Skills library, and the foundational-services catalog together with the developer-portal
// connection that feeds it.
//
// Split out of `dependencies.ts` when the service-catalog connection pushed that file past its size
// ratchet, along the seam the rest of the package already draws: `container-content-libraries.ts`
// holds the MODULE FACTORIES for exactly these three, so their dependency declarations now sit
// beside a file that names the same group. `CoreDependencies` extends this, so nothing about how a
// facade populates the bag changes.

/**
 * The three tenant-scoped content libraries a deployment can opt into, and the developer portal
 * that imports into the third.
 *
 * Every member is optional and each library assembles only when its own repositories are present,
 * which is what keeps a deployment that wants none of them byte-for-byte unchanged.
 */
export interface ContentLibraryDependencies {
  // ---- Prompt-fragment library (opt-in; ADR 0006) -------------------------
  // The managed, tenant-scoped catalog of best-practice fragments. The library
  // (per-tier CRUD + the merged-catalog resolver feeding every agent run)
  // assembles whenever `promptFragmentRepository` is present. Repo-sourced
  // fragments additionally need `fragmentSourceRepository`, the `githubClient`
  // (above) and an installation resolver. `fragmentSelector` is optional within
  // the module: absent → the deterministic matcher; present → the LLM selector.
  /**
   * The app-owned cache bag (docs/initiatives/caching-layer.md). A facade builds
   * it once per process via `createAppCaches` — Node threads in the Redis-backed
   * invalidation notifications in multi-node deployments, the Worker passes the
   * isolate-safe profile. Absent (tests / harnesses) ⇒ `createCore` builds bare
   * in-memory defaults, whose coherence the services' own invalidation calls keep.
   */
  caches?: AppCaches

  promptFragmentRepository?: PromptFragmentRepository
  fragmentSourceRepository?: FragmentSourceRepository
  fragmentSelector?: FragmentSelector
  resolveFragmentInstallationId?: ResolveFragmentInstallationId
  /**
   * Persisted store for MODEL-GENERATED condensed briefs — the short variant an implementer
   * kind folds when a long standard has no linked one. Absent ⇒ only authored/linked briefs
   * are folded and every other long standard is sent in full (the pre-feature behaviour).
   */
  fragmentBriefRepository?: FragmentBriefRepository
  /**
   * The condensation model behind those generated briefs. A facade leaves this unset and
   * gets the inline `LlmFragmentBriefGenerator` built from its own model provider; a
   * test/conformance harness injects a deterministic one instead (the same
   * "explicitly-injected wins" seam `documentContentResolver` uses).
   */
  fragmentBriefGenerator?: FragmentBriefGenerator
  /**
   * Live document reader for **document-backed** fragments (Confluence/Notion/
   * GitHub files linked as living best-practice fragments). Wired by a facade
   * from its document-source registry + connection service; absent → linking a
   * document as a fragment is rejected and run resolution uses cached bodies.
   */
  documentContentResolver?: DocumentContentResolver
  /**
   * Live document reader for the DEPLOYMENT's own documents: the living standard a code-registered
   * (`builtin`-tier) prompt fragment names, authenticated with credentials this deployment
   * configured centrally rather than with any tenant's connection.
   *
   * Its own field beside {@link documentContentResolver} because the difference is the CREDENTIAL
   * HOME, not an argument: that one resolves a workspace's stored connection, this one reads
   * deployment configuration and caches under one deployment-wide group. In MOTHERSHIP mode it is
   * REMOTE (the credentials live on the mothership and never reach a node, so the node reads the
   * resolved body over `/internal/prompt-fragments/document-bodies`).
   *
   * Absent ⇒ this deployment configured no document source of its own, and boot validation refuses
   * a code-registered `documentRef` rather than letting it render as live and fold something stale.
   */
  deploymentDocumentResolver?: DeploymentDocumentResolver

  // ---- Repo-sourced Claude Skills library (opt-in; ADR 0024) ----
  // An account's catalog of repo-authored Claude skills. The catalog read assembles
  // whenever `accountSkillRepository` is present; the source sync additionally needs
  // `skillSourceRepository`, the `githubClient` (above) and an installation resolver.
  accountSkillRepository?: AccountSkillRepository
  skillSourceRepository?: SkillSourceRepository
  resolveSkillInstallationId?: ResolveSkillInstallationId
  /**
   * Enqueues a targeted skill-source resync onto the runtime's GitHub-sync queue — the
   * push-webhook freshness fan-out (slice 4). Facade-provided (Worker Queue / Node pg-boss);
   * absent (no queue, or a pure-logic test) ⇒ no proactive resync, and freshness is guaranteed
   * at dispatch by the resolver's head-commit probe instead.
   */
  enqueueSkillResync?: (request: SkillSourceResyncRequest) => Promise<void>

  // ---- Foundational services (opt-in; backend/docs/adr/0031-foundational-services.md) ----
  // The tiered catalog of shared capabilities (file storage, notifications, audit …) an
  // Architect designs against and its consumers lazily read the API contracts of. The catalog
  // assembles whenever `foundationalServiceRepository` + `apiContractRepository` are present;
  // repo-sourced definitions additionally need `foundationalServiceSourceRepository`, the
  // `githubClient` (above) and an installation resolver (the fragment one, which already
  // resolves BOTH tiers).
  foundationalServiceRepository?: FoundationalServiceRepository
  apiContractRepository?: ApiContractRepository
  foundationalServiceSourceRepository?: FoundationalServiceSourceRepository
  /**
   * The workspace's SERVICE CATALOG connection: the developer portal (Backstage) whose services
   * are imported into the catalog above as `workspace`-tier rows. The import assembles only
   * alongside {@link serviceCatalogSecretCipher}, because the credential is sealed and a
   * connection nothing can open is a connection nothing can import through.
   */
  serviceCatalogConnectionRepository?: ServiceCatalogConnectionRepository
  /**
   * The cipher the portal credential is sealed with, on its OWN HKDF domain
   * (`cat-factory:service-catalog`) exactly as the runner-pool and email ones are: widening or
   * rotating one integration's key must not reach another's rows.
   */
  serviceCatalogSecretCipher?: SecretCipher
  /**
   * URL/host safety policy for the SERVICE-CATALOG integration (the portal base URL and any
   * OAuth token endpoint). Absent ⇒ strict (https-only, no private/internal hosts).
   *
   * Widening it is the normal case for this integration rather than an exception: a self-hosted
   * developer portal usually lives on an internal host. It is still scoped independently of the
   * environment and runner policies, so admitting `.corp.internal` here admits nothing there.
   */
  serviceCatalogUrlSafetyPolicy?: UrlSafetyPolicy
  /**
   * The app-owned registry of foundational services a DEPLOYMENT ships in CODE — the `builtin`
   * tier of the catalog merge, mirroring `pipelineRegistry` / `taskTypeRegistry`. Optional +
   * defaulted to `defaultFoundationalServiceRegistry()`, which ships exactly ONE service: the
   * platform's own asset storage, so a binary-output step has a target on a deployment that runs
   * no object store of its own. A facade injects the SAME instance it registers its estate on,
   * and boot validation reads it back so a malformed definition fails the deployment rather than
   * a design dispatch.
   */
  foundationalServiceRegistry?: FoundationalServiceRegistry
  /**
   * The app-owned registry of GENERATIVE BINARY INTEGRATIONS a DEPLOYMENT ships in CODE — the
   * image / music / video generation APIs a binary-generating step may call
   * (`stepOptions.binaryOutput.generatorIds`). Optional + defaulted to
   * `defaultBinaryGeneratorRegistry()` (EMPTY — the platform ships none, and every one of them is
   * a metered vendor), so existing construction sites behave exactly as before; a facade injects
   * the SAME instance it registers its integrations on, and boot validation reads it back so a
   * malformed definition or an unusable credential name fails the deployment rather than a
   * dispatch. Deliberately NOT the foundational-service registry: that catalog is what a design
   * is expected to build ON, while an integration is an instrument a specific step is pointed at.
   */
  binaryGeneratorRegistry?: BinaryGeneratorRegistry
  /**
   * The app-owned registry of BINARY ARTIFACT STORES a DEPLOYMENT ships in CODE: its own
   * implementations of the `BinaryBlobBackend` port, selectable per account beside the platform's
   * `fs` / `db` / `s3` / `r2` backends. Optional + defaulted to `defaultBinaryStoreRegistry()`
   * (EMPTY: the platform's own stores are not registry entries), so every existing construction
   * site behaves exactly as before.
   *
   * Unlike its generative sibling above this one does NOT get a mothership `Source`, and the
   * asymmetry is the point: a generator definition is DATA a run resolves, so a node reading its
   * own copy can disagree with the picker the mothership fed; a store is a live client that only
   * the process about to write the bytes can construct, so the process that answers the settings
   * picker is by construction the one that stores. There is nothing here for a machine API to
   * carry, and a `Source` would only invite pointing one node at another's credentials.
   */
  binaryStoreRegistry?: BinaryStoreRegistry
  /**
   * Where those integrations are READ from, when that is not this process's own registry.
   * Defaulted to `registryBinaryGeneratorSource(binaryGeneratorRegistry)` — i.e. exactly the
   * behaviour above — and overridden by ONE caller: a MOTHERSHIP-MODE node, which reads the
   * mothership's registry over `GET /internal/binary-generators`.
   *
   * The sibling of {@link foundationalBuiltinSource}, and it exists for the same reason with a
   * louder symptom. A mothership deployment is TWO processes, so a deployment had to register
   * its integrations on both entry points; a node one build behind — the normal state of a local
   * node — then refuses a step the mothership's own picker offered, with `unknown_generator`
   * naming a configuration that is correct. See `kernel/src/ports/binary-generators.ts`.
   *
   * When it is set, this process's own `binaryGeneratorRegistry` is NOT consulted for a run (the
   * facade warns at boot if it is non-empty) — the two are alternatives, never a merge: a merge
   * would reinstate the drift, since a stale local copy would win by id over the authoritative
   * one. The registry is still read for BOOT VALIDATION and for serving
   * `/internal/binary-generators` when this process is itself a mothership.
   */
  binaryGeneratorSource?: BinaryGeneratorSource
  /**
   * Where the `builtin` tier is READ from, when that is not this process's own registry.
   * Defaulted to `registryBuiltinSource(foundationalServiceRegistry)` — i.e. exactly the
   * behaviour above — and overridden by ONE caller: a MOTHERSHIP-MODE node, which reads the
   * mothership's registry over `GET /internal/foundational-services`.
   *
   * It exists because a mothership deployment is TWO processes and the estate is org state: with
   * the registry as the only route, a deployment had to register the same estate on both entry
   * points, and a node one build behind — the normal state of a local node — silently resolved a
   * catalog missing whatever the mothership had since added. A run then simply does not consider
   * that service, which is indistinguishable from an Architect judging it irrelevant. See
   * `kernel/src/ports/foundational-builtins.ts`.
   *
   * When it is set, this process's own `foundationalServiceRegistry` is NOT consulted for the
   * tier (the facade warns at boot if it is non-empty) — the two are alternatives, never a merge:
   * a merge would reinstate the drift, since a stale local copy would win by id over the
   * authoritative one.
   */
  foundationalBuiltinSource?: FoundationalBuiltinSource
  /**
   * The app-owned registry a deployment registers its best-practice PROMPT FRAGMENTS on, plus the
   * per-task-type default sets that select them. Optional + defaulted to
   * `defaultPromptFragmentRegistry()` (EMPTY, because the shipped catalog installs onto one through
   * `promptFragmentRegistryWithBuiltins()`, which is what each facade injects, so a caller that
   * passes nothing gets no standards rather than a silently different second pool).
   *
   * It replaced two module globals in `@cat-factory/prompt-fragments`, whose correctness depended
   * on every reader resolving the same physical copy of that package. The published graph does not
   * guarantee that, and the failure was silent: registrations landed in one copy, readers saw the
   * other, and every task of the deployment's operation was seeded with ids that folded nothing.
   */
  promptFragmentRegistry?: PromptFragmentRegistry
  /**
   * Where the fragment POOL is READ from, when that is not this process's own registry. The exact
   * sibling of {@link foundationalBuiltinSource}, with the same one overriding caller (a
   * mothership-mode node, over `GET /internal/prompt-fragments`) and the same alternatives-never-a-
   * merge rule: a merge would let a stale local copy win by id over the authoritative one, which is
   * the drift the source exists to remove.
   */
  promptFragmentSource?: PromptFragmentSource
  /**
   * Where the deployment's AGENT-KIND CAPABILITY layer is read from, when that is not this
   * process's own registry. Overridden by ONE caller: a mothership-mode node, over
   * `GET /internal/agent-kinds`.
   *
   * The fourth of the same family, and the only one that MERGES rather than replaces. Its three
   * siblings serve a set the node also registers, so a merge would let a stale local copy win by
   * id. Here the halves are different things: a KIND's own declarations belong to the code that
   * implements it (which cannot cross a wire, so the kind CATALOG stays node-local, exactly like
   * task types and pipelines, and a step naming an unknown kind still fails loudly at admission),
   * while `assignSkills`/`assignToolServers` are the DEPLOYMENT's layer on top — pure data whose
   * absence on a node one build behind is silent, since the agent simply works without the org's
   * playbook. Absent ⇒ the local registry answers alone.
   */
  agentKindSource?: AgentKindSource
  /**
   * Enqueues a targeted foundational-source resync onto the runtime's GitHub-sync queue — the
   * push-webhook freshness fan-out, the twin of {@link CoreDependencies.enqueueSkillResync}.
   * Facade-provided (Worker Queue / Node pg-boss); absent (no queue, or a pure-logic test) ⇒ no
   * proactive resync, and the autorefresh sweep bounds staleness instead.
   */
  enqueueFoundationalResync?: (request: FoundationalSourceResyncRequest) => Promise<void>
}
