<script setup lang="ts">
// Create a new task on the board. The user names the task and writes its
// description themselves (a REVIEW task is the one exception — it shows neither Title
// nor Description: the target PR IS the subject, so the title is derived from the PR
// reference and any notes go in the dedicated "Review focus" field). The task lands in
// `planned` state; it is never launched here. The user starts a pipeline on it
// explicitly (and can keep editing it until they do).
//
// The form also shows ungated "Context documents" / "Context issues" sections
// (mirroring the task inspector): an inline search picker (ContextDocumentPicker /
// ContextIssuePicker) finds already-imported items, search hits, or a pasted ref to
// attach as agent context. When the relevant integration isn't connected the Attach
// button is disabled with a hint. Linking needs the block id,
// so chosen items are staged locally and import-and-linked once the task is created
// (see useContextLinking) — the same context the agents see for every step of the run.
import type {
  CreateTaskType,
  DocKind,
  DocKindFieldKey,
  TaskSourceKind,
  TaskTypeFields,
} from '~/types/domain'
import { DOC_KINDS, DOC_KIND_FIELDS } from '~/types/domain'
import { resolveComponentRegistry } from '@modular-vue/core'
import { useReactiveSlots } from '@modular-vue/runtime'
import type { AppSlots, ResultViewContribution } from '~/modular/slots'
import ContextDocumentPicker from '~/components/documents/ContextDocumentPicker.vue'
import ContextIssuePicker from '~/components/tasks/ContextIssuePicker.vue'
import FragmentSelector from '~/components/fragments/FragmentSelector.vue'
import { riskPolicyOptionLabel, riskPolicySummary } from '~/utils/riskPolicy'
import { pipelineAllowedForManualStart } from '~/utils/pipeline'

const ui = useUiStore()
const board = useBoardStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const riskPolicies = useRiskPoliciesStore()
const modelPresets = useModelPresetsStore()
const pipelines = usePipelinesStore()
const agentConfig = useAgentConfigStore()
const fragments = useFragmentsStore()
const toast = useToast()
const { t } = useI18n()

const { linkPending, presentLinkFailures } = useContextLinking()

const open = computed({
  get: () => ui.addTaskContainerId !== null,
  set: (v: boolean) => {
    if (!v) void requestClose()
  },
})

const container = computed(() =>
  ui.addTaskContainerId ? board.getBlock(ui.addTaskContainerId) : undefined,
)

// The enclosing service frame: the container itself when it's a frame, else its parent
// frame (a module's parent). Drives which task types are offered — a document repository
// only authors documents/spikes, so the other kinds are hidden (and rejected server-side).
const frame = computed(() => {
  const c = container.value
  if (!c) return undefined
  return c.level === 'frame' ? c : c.parentId ? board.getBlock(c.parentId) : undefined
})
const isDocRepo = computed(() => frame.value?.type === 'document')

const title = ref('')
const description = ref('')
const saving = ref(false)
// Whether the user marks this as a purely technical task up front (a refactor /
// non-functional change). Left off ⇒ the engine infers it from the spec phase.
const technical = ref(false)

// The kind of task being created. `recurring` is special: it is created through the
// recurring-pipeline schedule flow (a schedule on the service frame), so picking it
// delegates to <RecurringPipelineModal> instead of creating a one-off task here.
type TaskTypeChoice = CreateTaskType | 'recurring'
const taskType = ref<TaskTypeChoice>('feature')
const TASK_TYPES = computed<{ value: TaskTypeChoice; label: string; icon: string }[]>(() => {
  const all: { value: TaskTypeChoice; label: string; icon: string }[] = [
    { value: 'feature', label: t('board.addTask.types.feature'), icon: 'i-lucide-sparkles' },
    { value: 'bug', label: t('board.addTask.types.bug'), icon: 'i-lucide-bug' },
    { value: 'document', label: t('board.addTask.types.document'), icon: 'i-lucide-file-text' },
    { value: 'spike', label: t('board.addTask.types.spike'), icon: 'i-lucide-flask-conical' },
    {
      value: 'review',
      label: t('board.addTask.types.review'),
      icon: 'i-lucide-clipboard-check',
    },
    { value: 'ralph', label: t('board.addTask.types.ralph'), icon: 'i-lucide-infinity' },
    { value: 'recurring', label: t('board.addTask.types.recurring'), icon: 'i-lucide-repeat' },
  ]
  // A document repository only accepts document/spike tasks (see BoardService.addTask).
  return isDocRepo.value ? all.filter((k) => k.value === 'document' || k.value === 'spike') : all
})
// Keep the selection valid when the target is a document repo (default to document).
watch(
  isDocRepo,
  (doc) => {
    if (doc && taskType.value !== 'document' && taskType.value !== 'spike') {
      taskType.value = 'document'
    }
  },
  { immediate: true },
)
const isRecurring = computed(() => taskType.value === 'recurring')

// Per-type fields (only the ones relevant to the chosen type are shown / sent).
const severity = ref<'low' | 'medium' | 'high' | 'critical' | ''>('')
const stepsToReproduce = ref('')
const timeboxHours = ref<number | undefined>(undefined)
// Spike research criteria — folded into the spike agent's prompt (see the backend `spike` kind).
const spikeResearchQuestion = ref('')
const spikeSuccessCriteria = ref('')
const spikeOptionsToCompare = ref('')
// Optional in-repo path the findings document is committed to (else `docs/research/<slug>.md`);
// shares the `taskTypeFields.targetPath` field + its safe-`.md`-path validation with `document`.
const spikeTargetPath = ref('')
// `DOC_KINDS` (and the `DocKind` type) are owned by the contracts package — re-exported via
// `~/types/domain` — so the picker and the create payload can't drift from the backend list.
const docKind = ref<DocKind | ''>('')
const docAudience = ref('')
const docTargetPath = ref('')
const docOutlineHints = ref('')
// Review-task fields: the target PR (entered as a full URL or a bare #number) + optional
// review focus. The single input is parsed into the contract's `prUrl`/`prNumber` fields.
const reviewPrRef = ref('')
const reviewFocus = ref('')

// Best-practice prompt fragments the user pins on the task up front (folded into its agents
// on top of the service-level standards, exactly like the inspector's picker). Chosen from the
// resolved catalog, filtered to the enclosing frame's block type ("appropriate scope").
const fragmentIds = ref<string[]>([])
const isReview = computed(() => taskType.value === 'review')

// Custom (deployment-registered) task types — the frontend-extension-mechanism slice B twin of
// custom agent kinds. The task-types store merges CODE-shipped (`taskTypes` slot) + BACKEND
// (snapshot `customTaskTypes`) into one catalog; the picker offers them alongside the built-ins.
// A document repo only accepts document/spike (server-rejected otherwise), so custom types are
// hidden there — mirroring the built-in `isDocRepo` filter.
const taskTypesStore = useTaskTypesStore()
const customTaskTypes = computed(() => (isDocRepo.value ? [] : taskTypesStore.customTaskTypes))
const selectedCustomType = computed(() =>
  customTaskTypes.value.find((tt) => tt.taskType === taskType.value),
)
// Descriptor-field values for a selected custom type (or a bespoke form panel's own bag), folded
// into `taskTypeFields.custom` on submit. Cleared when the type changes / the modal reopens.
const customFieldValues = ref<Record<string, string | number>>({})
// A bespoke create-form section paired to the custom type's `formPanel` id via the
// `taskTypeFormPanels` slot; shown INSTEAD of the descriptor fields. Unpaired ⇒ descriptor fields
// (degrade, never crash) — the same pairing shape as the result-view windows.
const appSlots = useReactiveSlots<AppSlots>()
const formPanelRegistry = computed(() =>
  resolveComponentRegistry((appSlots.value.taskTypeFormPanels ?? []) as ResultViewContribution[]),
)
const customFormPanel = computed(() => {
  const id = selectedCustomType.value?.formPanel
  return id ? (formPanelRegistry.value.get(id) ?? null) : null
})
// Whether every REQUIRED descriptor field of the selected custom type has a value. Only the
// descriptor path is enforced up front — a bespoke `formPanel` owns its own validation, so we
// don't block on it (nor can we read its required semantics). No custom type selected (or none
// of its fields are required) ⇒ trivially satisfied. Folded into `canAdd` so the required marker
// the form renders is actually honoured before submit.
const customRequiredFieldsFilled = computed(() => {
  const custom = selectedCustomType.value
  if (!custom || customFormPanel.value) return true
  return (custom.fields ?? []).every((field) => {
    if (!field.required) return true
    const raw = customFieldValues.value[field.key]
    return raw !== undefined && String(raw).trim() !== ''
  })
})
// The type picker: the built-in choices (i18n labels) + the custom types (their wire presentation).
const typeChoices = computed<{ value: TaskTypeChoice; label: string; icon: string }[]>(() => [
  ...TASK_TYPES.value,
  ...customTaskTypes.value.map((tt) => ({
    value: tt.taskType as TaskTypeChoice,
    label: tt.presentation.label,
    icon: tt.presentation.icon,
  })),
])

// Parse the PR-reference input into the contract fields: a bare positive integer (optionally
// `#`-prefixed) becomes `prNumber` (a PR on the service's linked repo); anything else is taken
// as a full URL (`prUrl`). Returns undefined when blank or unparseable — the caller uses that
// to require a target on a review task.
function parseReviewPrRef(raw: string): Pick<TaskTypeFields, 'prUrl' | 'prNumber'> | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const bareNumber = /^#?(\d+)$/.exec(trimmed)
  if (bareNumber) {
    const n = Number(bareNumber[1])
    return Number.isSafeInteger(n) && n >= 1 ? { prNumber: n } : undefined
  }
  return { prUrl: trimmed }
}

// A review task doesn't require a title (the PR reference IS the subject), so when the user
// leaves it blank we derive a concise one from the parsed PR ref — `owner/repo#123` from a
// GitHub-style URL, else `#number`, else a bare label — so the board card still reads sensibly.
function deriveReviewTitle(raw: string): string {
  const parsed = parseReviewPrRef(raw)
  if (parsed?.prNumber)
    return t('board.addTask.review.derivedTitle', { ref: `#${parsed.prNumber}` })
  if (parsed?.prUrl) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(parsed.prUrl)
    const refLabel = m ? `${m[1]}/${m[2]}#${m[3]}` : parsed.prUrl
    return t('board.addTask.review.derivedTitle', { ref: refLabel })
  }
  return t('board.addTask.review.derivedTitleFallback')
}
// Per-kind specific fields (see DOC_KIND_FIELDS). Held in one keyed record; only the fields
// for the selected kind are shown and submitted, so a value from a previously-selected kind is
// never sent. The catalog keys below keep the labels/placeholders i18n and drift-guarded.
const docKindFieldValues = reactive<Partial<Record<DocKindFieldKey, string>>>({})
const docKindFields = computed(() => (docKind.value ? (DOC_KIND_FIELDS[docKind.value] ?? []) : []))
// Exhaustive Record<DocKindFieldKey, key> of catalog keys — the initiative's drift guard for a
// dynamic enum→key lookup (a missing enum member is a compile error here; a locale that omits a
// key falls back via `te()` rather than leaking a raw key). Do NOT inline as bare template keys.
const DOC_FIELD_LABEL_KEYS: Record<DocKindFieldKey, string> = {
  targetUsers: 'board.addTask.docFields.targetUsers.label',
  successMetrics: 'board.addTask.docFields.successMetrics.label',
  alternativesConsidered: 'board.addTask.docFields.alternativesConsidered.label',
  rolloutConcerns: 'board.addTask.docFields.rolloutConcerns.label',
  decisionDrivers: 'board.addTask.docFields.decisionDrivers.label',
  consideredOptions: 'board.addTask.docFields.consideredOptions.label',
  whenToUse: 'board.addTask.docFields.whenToUse.label',
  escalationPath: 'board.addTask.docFields.escalationPath.label',
  researchQuestion: 'board.addTask.docFields.researchQuestion.label',
  optionsToCompare: 'board.addTask.docFields.optionsToCompare.label',
  apiSurface: 'board.addTask.docFields.apiSurface.label',
}
const DOC_FIELD_PLACEHOLDER_KEYS: Record<DocKindFieldKey, string> = {
  targetUsers: 'board.addTask.docFields.targetUsers.placeholder',
  successMetrics: 'board.addTask.docFields.successMetrics.placeholder',
  alternativesConsidered: 'board.addTask.docFields.alternativesConsidered.placeholder',
  rolloutConcerns: 'board.addTask.docFields.rolloutConcerns.placeholder',
  decisionDrivers: 'board.addTask.docFields.decisionDrivers.placeholder',
  consideredOptions: 'board.addTask.docFields.consideredOptions.placeholder',
  whenToUse: 'board.addTask.docFields.whenToUse.placeholder',
  escalationPath: 'board.addTask.docFields.escalationPath.placeholder',
  researchQuestion: 'board.addTask.docFields.researchQuestion.placeholder',
  optionsToCompare: 'board.addTask.docFields.optionsToCompare.placeholder',
  apiSurface: 'board.addTask.docFields.apiSurface.placeholder',
}
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

function buildTypeFields(): TaskTypeFields | undefined {
  if (taskType.value === 'bug') {
    const f: TaskTypeFields = {}
    if (severity.value) f.severity = severity.value
    if (stepsToReproduce.value.trim()) f.stepsToReproduce = stepsToReproduce.value.trim()
    return Object.keys(f).length ? f : undefined
  }
  if (taskType.value === 'spike') {
    const f: TaskTypeFields = {}
    // `v-model.number` on a cleared number input yields '' (not undefined), which would
    // serialise as a non-number and 400 the create — so require a finite number here.
    if (
      typeof timeboxHours.value === 'number' &&
      Number.isFinite(timeboxHours.value) &&
      timeboxHours.value >= 0
    ) {
      f.timeboxHours = timeboxHours.value
    }
    if (spikeResearchQuestion.value.trim()) f.researchQuestion = spikeResearchQuestion.value.trim()
    if (spikeSuccessCriteria.value.trim()) f.successCriteria = spikeSuccessCriteria.value.trim()
    if (spikeOptionsToCompare.value.trim()) f.optionsToCompare = spikeOptionsToCompare.value.trim()
    if (spikeTargetPath.value.trim()) f.targetPath = spikeTargetPath.value.trim()
    return Object.keys(f).length ? f : undefined
  }
  if (taskType.value === 'document') {
    const f: TaskTypeFields = {}
    if (docKind.value) f.docKind = docKind.value
    if (docAudience.value.trim()) f.audience = docAudience.value.trim()
    if (docTargetPath.value.trim()) f.targetPath = docTargetPath.value.trim()
    if (docOutlineHints.value.trim()) f.outlineHints = docOutlineHints.value.trim()
    // Only the selected kind's fields are read, so a stale value for another kind is dropped.
    for (const spec of docKindFields.value) {
      const value = docKindFieldValues[spec.key]?.trim()
      if (value) f[spec.key] = value
    }
    return Object.keys(f).length ? f : undefined
  }
  if (taskType.value === 'review') {
    const f: TaskTypeFields = { ...parseReviewPrRef(reviewPrRef.value) }
    if (reviewFocus.value.trim()) f.reviewFocus = reviewFocus.value.trim()
    return Object.keys(f).length ? f : undefined
  }
  // A CUSTOM (deployment-registered) task type: fold the collected values into the sparse
  // `taskTypeFields.custom` bag. A bespoke form panel owns the whole bag (taken verbatim); the
  // descriptor path reads only the declared fields, coercing a `number` descriptor's string input.
  const custom = selectedCustomType.value
  if (custom) {
    const bag: Record<string, string | number> = {}
    if (customFormPanel.value) {
      for (const [key, value] of Object.entries(customFieldValues.value)) {
        if (value !== undefined && value !== '') bag[key] = value
      }
    } else {
      for (const field of custom.fields ?? []) {
        const raw = customFieldValues.value[field.key]
        if (raw === undefined || raw === '') continue
        if (field.type === 'number') {
          // Skip a non-numeric value rather than sending NaN (which serialises to null on the wire).
          const n = Number(raw)
          if (Number.isFinite(n)) bag[field.key] = n
        } else {
          bag[field.key] = raw
        }
      }
    }
    return Object.keys(bag).length ? { custom: bag } : undefined
  }
  return undefined
}

// For a recurring task, the schedule attaches to the service frame: the container itself
// when it's a frame, else its parent frame (a module's parent).
const recurringFrameId = computed(() => {
  const c = container.value
  if (!c) return null
  return c.level === 'frame' ? c.id : c.parentId
})

// Run configuration picked up front. Empty string = use the default (workspace
// default merge preset / no pinned pipeline).
const riskPolicyId = ref('')
const modelPresetId = ref('')
const pipelineId = ref('')

const defaultPresetLabel = computed(() =>
  riskPolicies.defaultPreset
    ? t('board.addTask.defaultPreset', {
        name: riskPolicies.defaultPreset.name,
        thresholds: riskPolicySummary(riskPolicies.defaultPreset),
      })
    : t('board.addTask.workspaceDefault'),
)
const presetMenu = computed(() => [
  [
    {
      label: defaultPresetLabel.value,
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => (riskPolicyId.value = ''),
    },
    ...riskPolicies.presets.map((p) => ({
      label: riskPolicyOptionLabel(p),
      icon: 'i-lucide-git-merge',
      onSelect: () => (riskPolicyId.value = p.id),
    })),
  ],
])
const selectedPresetLabel = computed(() => {
  if (!riskPolicyId.value) return defaultPresetLabel.value
  const picked = riskPolicies.presets.find((p) => p.id === riskPolicyId.value)
  return picked ? riskPolicyOptionLabel(picked) : t('board.addTask.workspaceDefault')
})

// Model preset: which model each agent runs on. Empty = workspace default preset.
const defaultModelPresetLabel = computed(() =>
  modelPresets.defaultPreset
    ? t('board.addTask.defaultModelPreset', { name: modelPresets.defaultPreset.name })
    : t('board.addTask.workspaceDefault'),
)
const modelPresetMenu = computed(() => [
  [
    {
      label: defaultModelPresetLabel.value,
      icon: 'i-lucide-rotate-ccw',
      onSelect: () => (modelPresetId.value = ''),
    },
    ...modelPresets.presets.map((p) => ({
      label: p.name,
      icon: 'i-lucide-cpu',
      onSelect: () => (modelPresetId.value = p.id),
    })),
  ],
])
const selectedModelPresetLabel = computed(() => {
  if (!modelPresetId.value) return defaultModelPresetLabel.value
  return (
    modelPresets.presets.find((p) => p.id === modelPresetId.value)?.name ??
    t('board.addTask.workspaceDefault')
  )
})

// ---- best-practice prompt fragments (pinned at creation) -------------------
// The pool the shared <FragmentSelector> offers: fragments appropriate to the enclosing frame's
// block type (the "scope"). Falls back to `service` before a frame resolves so the catalog is
// still browsable.
const fragmentPool = computed(() => fragments.forBlockType(frame.value?.type ?? 'service'))

// Hide UI-testing pipelines (`tester-ui` / `visual-confirmation`) when the target frame has no
// UI to exercise — they'd be refused server-side (see utils/pipeline + the backend gate). Also
// hide `'recurring'`-only pipelines (a one-off task start of one is refused at run start) and,
// for a `document` / `review` task, every pipeline whose purpose doesn't match (a doc task authors
// a doc, a review task reviews a PR — only document / review pipelines are relevant, per the
// `purpose` classifier). Re-filters as the chosen task type changes.
const selectablePipelines = computed(() =>
  pipelines.pipelines.filter((p) =>
    pipelineAllowedForManualStart(p, frame.value, board.blocks, taskType.value),
  ),
)
// Some task types want their type-default pipeline surfaced in the modal up front, so picking the
// type auto-selects it (the user can still change it among the still-offered pipelines). This is a
// DELIBERATE SUBSET of the backend `defaultPipelineIdForTaskType` — only the types whose default
// must appear in the form BEFORE creation:
//   - `ralph` needs its preset so the per-task validation command + iteration budget the `ralph`
//     agent contributes surface for editing ("choose at run time" would be a dead end);
//   - a `document` task defaults to `pl_document` and a `review` task to `pl_review` so their
//     purpose-narrowed picker (the `purpose` gate hides every non-document / non-review pipeline)
//     is never rendered empty.
// The other typed default (spike) carries no up-front config and doesn't narrow its picker, so the
// modal leaves `pipelineId` unset and `BoardService` applies the backend type-default at creation.
// Keep these ids in step with the backend helper.
const DEFAULT_PIPELINE_FOR_TYPE: Partial<Record<TaskTypeChoice, string>> = {
  ralph: 'pl_ralph',
  document: 'pl_document',
  review: 'pl_review',
}
watch(taskType, (next) => {
  // A custom type owns a fresh field bag on every switch (its descriptors differ per type).
  customFieldValues.value = {}
  // Pre-select the type's default pipeline: a custom type's registered `defaultPipelineId`, else
  // the built-in map. (For a custom type with no default, `BoardService` applies the registry
  // default at creation, so leaving the picker unset is fine.)
  const custom = customTaskTypes.value.find((tt) => tt.taskType === next)
  const preset = custom?.defaultPipelineId ?? DEFAULT_PIPELINE_FOR_TYPE[next]
  if (!preset) return
  const match = pipelines.pipelines.find((p) => p.id === preset)
  if (match) pipelineId.value = match.id
})

// Task-level agent config contributed by the selected pipeline's agents (e.g. the
// Tester's environment). Editable up front; persisted on the task and frozen once
// the contributing agent runs. Defaults to each descriptor's default until changed.
const agentConfigValues = ref<Record<string, string>>({})
const configDescriptors = computed(() => agentConfig.forPipeline(pipelineId.value))
function configValue(id: string, fallback: string): string {
  return agentConfigValues.value[id] ?? fallback
}
function setConfig(id: string, value: string) {
  agentConfigValues.value = { ...agentConfigValues.value, [id]: value }
}

// Context the user chose to attach to the new task (already-imported items + the
// import flow), committed once the block exists (see add() → linkPending).
const pendingContext = ref<PendingContext[]>([])

// The Context documents / Context issues sections mirror the task inspector but are
// always shown (ungated): when the relevant integration isn't connected the Attach
// button becomes a "Connect a source" action instead. Connecting opens the source's
// connect modal OVER this one (both are root-mounted with independent open flags), so
// the user's in-progress task data is preserved rather than lost to a navigation away.
const docsConnected = computed(() => documents.available && documents.anyConnected)
const issuesConnected = computed(() => tasks.available && tasks.anyOffered)

// Sources the user could connect right now to unlock the picker, when none is connected
// yet: for documents, every configured source without a live connection (GitHub docs are
// already implicitly connected via the App, so they never appear here); for issues, every
// configured tracker not yet available (a connected credentialed source, or the installed
// GitHub App). The connect modals are the same ones the Integrations hub opens.
const connectableDocSources = computed(() =>
  documents.available ? documents.sources.filter((s) => !documents.isConnected(s.source)) : [],
)
const connectableIssueSources = computed(() =>
  tasks.available ? tasks.sources.filter((s) => !s.available) : [],
)
const connectDocMenu = computed(() => [
  connectableDocSources.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    onSelect: () => ui.openDocumentConnect(s.source),
  })),
])
const connectIssueMenu = computed(() => [
  connectableIssueSources.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    onSelect: () => ui.openTaskConnect(s.source),
  })),
])
const pendingDocs = computed(() => pendingContext.value.filter((c) => c.kind === 'document'))
const pendingIssues = computed(() => pendingContext.value.filter((c) => c.kind === 'task'))

// Linked issues whose body is in hand, surfaced read-only above the description so the
// user SEES the original issue description is included in the task (and can add notes on
// top). The bodies are folded into the saved description on submit (see `add`).
const linkedIssueBodies = computed(() =>
  pendingIssues.value
    .filter((i) => (i.description ?? '').trim().length > 0)
    .map((i) => ({ key: contextKey(i), title: i.title, body: (i.description ?? '').trim() })),
)
const hasLinkedIssueBody = computed(() => linkedIssueBodies.value.length > 0)
// True while we're fetching a search-hit issue's body so the read-only preview can show
// a placeholder instead of silently appearing late.
const resolvingIssueBodies = ref(false)

// A staged issue picked from search results carries no body yet (`needsImport`, and the
// search result has no description). Resolve it once the form opens — from the local cache
// when already imported, else by importing it (idempotent; we'd import on add anyway) — so
// its description can be shown read-only and folded into the task. Best-effort: a failure
// just leaves that issue without a preview, still linked on add.
async function resolvePendingIssueBodies() {
  const unresolved = pendingContext.value.filter(
    (c) => c.kind === 'task' && !(c.description ?? '').trim(),
  )
  if (!unresolved.length) return
  resolvingIssueBodies.value = true
  try {
    const resolved: Record<string, string> = {}
    for (const item of unresolved) {
      const source = item.source as TaskSourceKind
      const cached = tasks.tasks.find(
        (t) => t.source === source && t.externalId === item.externalId,
      )
      if ((cached?.description ?? '').trim()) {
        resolved[contextKey(item)] = cached!.description
        continue
      }
      if (!item.needsImport) continue
      try {
        const imported = await tasks.importTask(source, item.externalId)
        if ((imported.description ?? '').trim()) resolved[contextKey(item)] = imported.description
      } catch {
        // Unreadable/forbidden issue — skip the preview; it still links on add.
      }
    }
    if (Object.keys(resolved).length) {
      // The issue is now imported, so it links directly on add (needsImport → false).
      pendingContext.value = pendingContext.value.map((c) => {
        const body = resolved[contextKey(c)]
        return body ? { ...c, description: body, needsImport: false } : c
      })
    }
  } finally {
    resolvingIssueBodies.value = false
  }
}

function addPending(item: PendingContext) {
  if (pendingContext.value.some((c) => contextKey(c) === contextKey(item))) return
  pendingContext.value = [...pendingContext.value, item]
}
function removePending(item: PendingContext) {
  pendingContext.value = pendingContext.value.filter((c) => contextKey(c) !== contextKey(item))
}

// Context documents and issues are both picked through an inline search picker
// (ContextDocumentPicker / ContextIssuePicker) rather than a dropdown that opens a
// second modal — stacked page-level modals don't interact here, which is why the
// old "Import a page…" / "Import an issue…" entries appeared to open something but
// nothing was clickable. The "Attach" button toggles the relevant picker open.
const showDocPicker = ref(false)
const chosenDocKeys = computed(() => pendingDocs.value.map(contextKey))
const showIssuePicker = ref(false)
const chosenIssueKeys = computed(() => pendingIssues.value.map(contextKey))

// Reset the form whenever the modal opens for a (new) container, and refresh the
// imported docs/issues so the quick-pick list is current.
watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''
  description.value = ''
  saving.value = false
  // This reset runs after the `isDocRepo` watcher in the same open tick, so it must pick the
  // doc-repo-aware default itself — a document frame only offers document/spike, so `feature`
  // would leave the selector on a hidden, server-rejected value.
  taskType.value = isDocRepo.value ? 'document' : 'feature'
  technical.value = false
  severity.value = ''
  stepsToReproduce.value = ''
  timeboxHours.value = undefined
  spikeResearchQuestion.value = ''
  spikeSuccessCriteria.value = ''
  spikeOptionsToCompare.value = ''
  spikeTargetPath.value = ''
  docKind.value = ''
  docAudience.value = ''
  docTargetPath.value = ''
  docOutlineHints.value = ''
  reviewPrRef.value = ''
  reviewFocus.value = ''
  customFieldValues.value = {}
  // Pre-seed the best-practice fragments from the enclosing service's standards, so a new task
  // ships with its service's fragments already selected (and freely add/removable here). The task
  // OWNS this selection from creation — the engine folds exactly these, without re-unioning the
  // service's set, so removing one here actually drops it for this task.
  fragmentIds.value = [...(frame.value?.serviceFragmentIds ?? [])]
  for (const key of Object.keys(docKindFieldValues) as DocKindFieldKey[])
    delete docKindFieldValues[key]
  riskPolicyId.value = ''
  modelPresetId.value = ''
  // Seed the pipeline from the (possibly doc-repo-forced) task type's default, so a document
  // repo opens with `pl_document` pre-selected rather than empty. This runs AFTER the `taskType`
  // watcher fired during this reset, so it is the authoritative default (see DEFAULT_PIPELINE_FOR_TYPE).
  pipelineId.value = DEFAULT_PIPELINE_FOR_TYPE[taskType.value] ?? ''
  agentConfigValues.value = {}
  pendingContext.value = []
  showDocPicker.value = false
  showIssuePicker.value = false
  // Seed from a prefill when opened from another surface (e.g. "create task from
  // issue" sets the title + stages the issue as linked context). Pipeline / preset
  // are intentionally left at their defaults so the user confirms them here.
  const prefill = ui.addTaskPrefill
  if (prefill) {
    if (prefill.title) title.value = prefill.title
    if (prefill.description) description.value = prefill.description
    if (prefill.context?.length) pendingContext.value = [...prefill.context]
  }
  documents.loadDocuments().catch(() => {})
  tasks.loadTasks().catch(() => {})
  // Load the best-practice fragment catalog so the picker is populated (no-op while current).
  fragments.ensureLoaded().catch(() => {})
  // Fetch any staged search-hit issue's body so its description shows read-only below.
  resolvePendingIssueBodies().catch(() => {})
})

// UX-18: prompt before discarding typed input on Escape / backdrop / Cancel. Registered
// after the reset watcher so the baseline is the seeded form (a prefill is the clean
// starting point, not a spurious edit). The snapshot covers the user-owned fields — the
// cheap task-type / technical toggles are excluded, and only the *stable* context keys are
// compared so the async issue-body resolution never reads as a change.
const { requestClose } = useUnsavedGuard({
  open,
  close: () => ui.closeAddTask(),
  saving: () => saving.value,
  snapshot: () => ({
    title: title.value.trim(),
    description: description.value.trim(),
    severity: severity.value,
    stepsToReproduce: stepsToReproduce.value.trim(),
    timeboxHours: timeboxHours.value ?? null,
    spikeResearchQuestion: spikeResearchQuestion.value.trim(),
    spikeSuccessCriteria: spikeSuccessCriteria.value.trim(),
    spikeOptionsToCompare: spikeOptionsToCompare.value.trim(),
    spikeTargetPath: spikeTargetPath.value.trim(),
    docKind: docKind.value,
    docAudience: docAudience.value.trim(),
    docTargetPath: docTargetPath.value.trim(),
    docOutlineHints: docOutlineHints.value.trim(),
    docKindFieldValues: { ...docKindFieldValues },
    riskPolicyId: riskPolicyId.value,
    modelPresetId: modelPresetId.value,
    pipelineId: pipelineId.value,
    agentConfig: { ...agentConfigValues.value },
    fragmentIds: [...fragmentIds.value],
    context: pendingContext.value.map(contextKey),
  }),
})

// A recurring task only needs a target frame (its details are filled in the schedule
// modal); every other type needs a title. A review task additionally needs a target PR.
// The Ralph loop's completion criterion (its `ralph.validationCommand` agent-config id). The
// loop is meaningless without it, so the create form requires it up front — the backend also
// refuses to start a Ralph run without one (a 422), this just fails fast in the UI.
const RALPH_VALIDATION_COMMAND_ID = 'ralph.validationCommand'

const canAdd = computed(() => {
  if (isRecurring.value) return recurringFrameId.value !== null
  // A review task doesn't require a title (the PR reference is the subject — we derive one),
  // so it only needs a valid target PR. Every other type still requires a title.
  if (isReview.value) return parseReviewPrRef(reviewPrRef.value) !== undefined
  if (title.value.trim().length === 0) return false
  if (
    taskType.value === 'ralph' &&
    configValue(RALPH_VALIDATION_COMMAND_ID, '').trim().length === 0
  )
    return false
  // A custom type's required descriptor fields must be filled (its form renders them as required).
  if (!customRequiredFieldsFilled.value) return false
  return true
})

async function add() {
  const containerId = ui.addTaskContainerId
  if (!containerId || !canAdd.value) return
  // Recurring tasks are created via a schedule on the service frame — hand off to the
  // existing recurring-pipeline modal (which carries the cadence + prompt).
  if (isRecurring.value) {
    const frameId = recurringFrameId.value
    if (!frameId) return
    ui.closeAddTask()
    ui.openAddRecurring(frameId)
    return
  }
  saving.value = true
  try {
    const typeFields = buildTypeFields()
    // The saved description includes each linked issue's body (shown read-only above)
    // followed by the user's own notes, so the original issue description is part of the
    // task — not only reachable via the context link.
    const notes = description.value.trim()
    const fullDescription =
      [...linkedIssueBodies.value.map((b) => b.body), notes].filter(Boolean).join('\n\n') ||
      undefined
    // A review task's title is optional; when blank we derive one from the PR reference so the
    // board card still reads sensibly (the backend also folds the PR ref into the description).
    const effectiveTitle =
      title.value.trim() || (isReview.value ? deriveReviewTitle(reviewPrRef.value) : '')
    const block = await board.addTask(containerId, effectiveTitle, fullDescription, {
      taskType: taskType.value as CreateTaskType,
      ...(typeFields ? { taskTypeFields: typeFields } : {}),
      // A review task merges nothing, so its risk (merge) policy is meaningless — never send it.
      ...(riskPolicyId.value && !isReview.value ? { riskPolicyId: riskPolicyId.value } : {}),
      ...(modelPresetId.value ? { modelPresetId: modelPresetId.value } : {}),
      ...(pipelineId.value ? { pipelineId: pipelineId.value } : {}),
      ...(Object.keys(agentConfigValues.value).length
        ? { agentConfig: agentConfigValues.value }
        : {}),
      // Always send the (service-seeded, then user-edited) selection — including an empty list,
      // which means "the user cleared the inherited picks" and must be honoured rather than
      // re-seeded from the service. The task owns its fragments from here.
      fragmentIds: [...fragmentIds.value],
      ...(technical.value ? { technical: true } : {}),
    })
    if (block) {
      // Surface the SPECIFIC cause of any attachment that couldn't be linked (a GitHub
      // permission/visibility error, a not-found doc, …) instead of a bare count, plus a
      // one-click "Copy details" for a bug report.
      presentLinkFailures(await linkPending(block.id, pendingContext.value), block.id)
    }
    ui.closeAddTask()
  } catch (e) {
    toast.add({
      title: t('board.addTask.addFailedTitle'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('board.addTask.title')">
    <template #body>
      <div class="space-y-4" data-testid="add-task-modal">
        <p v-if="container" class="text-xs text-slate-400">
          <i18n-t keypath="board.addTask.newTaskIn" tag="span" scope="global">
            <template #container>
              <span class="font-medium text-slate-200">{{ container.title }}</span>
            </template>
          </i18n-t>
        </p>

        <UFormField :label="t('board.addTask.typeLabel')">
          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="ty in typeChoices"
              :key="ty.value"
              :color="taskType === ty.value ? 'primary' : 'neutral'"
              :variant="taskType === ty.value ? 'soft' : 'ghost'"
              :icon="ty.icon"
              size="xs"
              :data-testid="`task-type-${ty.value}`"
              @click="
                () => {
                  taskType = ty.value
                }
              "
            >
              {{ ty.label }}
            </UButton>
          </div>
        </UFormField>

        <!-- Recurring tasks are configured as a schedule on the service frame. -->
        <div
          v-if="isRecurring"
          class="rounded-lg border border-slate-800 p-3 text-[11px] text-slate-400"
        >
          <template v-if="recurringFrameId">
            {{ t('board.addTask.recurringWithFrame') }}
          </template>
          <template v-else>
            {{ t('board.addTask.recurringNoFrame') }}
          </template>
        </div>

        <template v-if="!isRecurring">
          <!-- A review task shows neither Title nor Description: the target PR is the
               subject (the title is derived from the PR reference), and any notes go in
               the dedicated "Review focus" field below. -->
          <UFormField v-if="!isReview" :label="t('board.addTask.titleField')" required>
            <UInput
              v-model="title"
              data-testid="add-task-title"
              :placeholder="t('board.addTask.titlePlaceholder')"
              autofocus
              class="w-full"
              @keydown.enter="add"
            />
          </UFormField>

          <template v-if="!isReview">
            <!-- Linked issue description(s), read-only: shown so the user sees the original
                 issue description is included in the task. It's folded into the saved
                 description (before their notes) on add. -->
            <UFormField
              v-for="issue in linkedIssueBodies"
              :key="issue.key"
              :label="t('board.addTask.issueIncluded', { title: issue.title })"
            >
              <UTextarea
                :model-value="issue.body"
                :rows="4"
                autoresize
                readonly
                class="w-full"
                :ui="{ base: 'cursor-default text-slate-300' }"
              />
            </UFormField>
            <p v-if="resolvingIssueBodies" class="text-[11px] text-slate-500">
              {{ t('board.addTask.loadingIssue') }}
            </p>

            <UFormField
              :label="
                hasLinkedIssueBody
                  ? t('board.addTask.additionalNotes')
                  : t('board.addTask.description')
              "
            >
              <UTextarea
                v-model="description"
                :rows="4"
                autoresize
                :placeholder="
                  hasLinkedIssueBody
                    ? t('board.addTask.notesPlaceholder')
                    : t('board.addTask.descriptionPlaceholder')
                "
                class="w-full"
              />
            </UFormField>
          </template>

          <UCheckbox v-model="technical" name="technical">
            <template #label>
              <span class="text-sm text-slate-200">{{ t('board.addTask.technical') }}</span>
            </template>
            <template #description>
              <span class="text-[11px] text-slate-500">
                {{ t('board.addTask.technicalHint') }}
              </span>
            </template>
          </UCheckbox>

          <!-- Per-type fields. -->
          <div v-if="taskType === 'bug'" class="grid grid-cols-2 gap-3">
            <UFormField :label="t('board.addTask.severity')">
              <div class="flex flex-wrap gap-1">
                <UButton
                  v-for="s in SEVERITIES"
                  :key="s"
                  :color="severity === s ? 'primary' : 'neutral'"
                  :variant="severity === s ? 'soft' : 'ghost'"
                  size="xs"
                  class="capitalize"
                  @click="
                    () => {
                      severity = severity === s ? '' : s
                    }
                  "
                >
                  {{ s }}
                </UButton>
              </div>
            </UFormField>
            <UFormField :label="t('board.addTask.stepsToReproduce')" class="col-span-2">
              <UTextarea
                v-model="stepsToReproduce"
                :rows="2"
                autoresize
                :placeholder="t('board.addTask.stepsToReproducePlaceholder')"
                class="w-full"
              />
            </UFormField>
          </div>

          <div v-else-if="taskType === 'spike'" class="space-y-3">
            <UFormField :label="t('board.addTask.timebox')">
              <UInput
                v-model.number="timeboxHours"
                type="number"
                min="0"
                :placeholder="t('board.addTask.timeboxPlaceholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('board.addTask.spikeFields.researchQuestion.label')"
              :hint="t('board.addTask.optional')"
            >
              <UInput
                v-model="spikeResearchQuestion"
                :placeholder="t('board.addTask.spikeFields.researchQuestion.placeholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('board.addTask.spikeFields.successCriteria.label')"
              :hint="t('board.addTask.optional')"
            >
              <UTextarea
                v-model="spikeSuccessCriteria"
                :rows="2"
                autoresize
                :placeholder="t('board.addTask.spikeFields.successCriteria.placeholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('board.addTask.spikeFields.optionsToCompare.label')"
              :hint="t('board.addTask.optional')"
            >
              <UTextarea
                v-model="spikeOptionsToCompare"
                :rows="2"
                autoresize
                :placeholder="t('board.addTask.spikeFields.optionsToCompare.placeholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="t('board.addTask.targetPath')" :hint="t('board.addTask.optional')">
              <UInput
                v-model="spikeTargetPath"
                :placeholder="t('board.addTask.targetPathPlaceholder')"
                class="w-full"
              />
            </UFormField>
          </div>

          <div v-else-if="taskType === 'document'" class="space-y-3">
            <UFormField :label="t('board.addTask.documentKind')">
              <div class="flex flex-wrap gap-1">
                <UButton
                  v-for="k in DOC_KINDS"
                  :key="k"
                  :color="docKind === k ? 'primary' : 'neutral'"
                  :variant="docKind === k ? 'soft' : 'ghost'"
                  size="xs"
                  class="uppercase"
                  @click="
                    () => {
                      docKind = docKind === k ? '' : k
                    }
                  "
                >
                  {{ k }}
                </UButton>
              </div>
            </UFormField>
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('board.addTask.audience')" :hint="t('board.addTask.optional')">
                <UInput
                  v-model="docAudience"
                  :placeholder="t('board.addTask.audiencePlaceholder')"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('board.addTask.targetPath')"
                :hint="t('board.addTask.optional')"
              >
                <UInput
                  v-model="docTargetPath"
                  :placeholder="t('board.addTask.targetPathPlaceholder')"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UFormField
              :label="t('board.addTask.outlineHints')"
              :hint="t('board.addTask.optional')"
            >
              <UTextarea
                v-model="docOutlineHints"
                :rows="2"
                :placeholder="t('board.addTask.outlineHintsPlaceholder')"
                class="w-full"
              />
            </UFormField>
            <!-- Kind-specific fields — only those relevant to the selected docKind are shown. -->
            <UFormField
              v-for="spec in docKindFields"
              :key="spec.key"
              :label="t(DOC_FIELD_LABEL_KEYS[spec.key])"
              :hint="t('board.addTask.optional')"
            >
              <UTextarea
                v-if="spec.multiline"
                v-model="docKindFieldValues[spec.key]"
                :rows="2"
                :placeholder="t(DOC_FIELD_PLACEHOLDER_KEYS[spec.key])"
                class="w-full"
              />
              <UInput
                v-else
                v-model="docKindFieldValues[spec.key]"
                :placeholder="t(DOC_FIELD_PLACEHOLDER_KEYS[spec.key])"
                class="w-full"
              />
            </UFormField>
          </div>

          <div v-else-if="taskType === 'review'" class="space-y-3">
            <UFormField
              :label="t('board.addTask.review.prUrl')"
              :hint="t('board.addTask.review.prUrlHint')"
              required
            >
              <UInput
                v-model="reviewPrRef"
                placeholder="https://github.com/owner/repo/pull/123"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('board.addTask.review.focus')"
              :hint="t('board.addTask.optional')"
            >
              <UTextarea
                v-model="reviewFocus"
                :rows="2"
                :placeholder="t('board.addTask.review.focusPlaceholder')"
                class="w-full"
              />
            </UFormField>
          </div>

          <!-- A CUSTOM (deployment-registered) task type: a bespoke create-form section when its
               `formPanel` is paired to the `taskTypeFormPanels` slot, else the descriptor-driven
               `fields` the type declares. None of the built-in `v-if` branches above match a
               namespaced custom type, so this renders on its own. -->
          <div v-if="selectedCustomType" class="space-y-3" data-testid="custom-task-fields">
            <component
              :is="customFormPanel"
              v-if="customFormPanel"
              :task-type="selectedCustomType"
              :model-value="customFieldValues"
              @update:model-value="customFieldValues = $event"
            />
            <template v-else>
              <UFormField
                v-for="field in selectedCustomType.fields ?? []"
                :key="field.key"
                :label="field.label"
                :help="field.help"
                :required="field.required"
              >
                <div v-if="field.type === 'select'" class="flex flex-wrap gap-1">
                  <UButton
                    v-for="opt in field.options ?? []"
                    :key="opt.value"
                    :color="customFieldValues[field.key] === opt.value ? 'primary' : 'neutral'"
                    :variant="customFieldValues[field.key] === opt.value ? 'soft' : 'ghost'"
                    size="xs"
                    :data-testid="`custom-field-${field.key}-${opt.value}`"
                    @click="() => (customFieldValues[field.key] = opt.value)"
                  >
                    {{ opt.label }}
                  </UButton>
                </div>
                <UTextarea
                  v-else-if="field.type === 'textarea'"
                  v-model="customFieldValues[field.key]"
                  :rows="2"
                  :maxlength="field.maxLength"
                  :placeholder="field.placeholder"
                  :data-testid="`custom-field-${field.key}`"
                  class="w-full"
                />
                <UInput
                  v-else
                  v-model="customFieldValues[field.key]"
                  :type="field.type === 'number' ? 'number' : 'text'"
                  :maxlength="field.maxLength"
                  :placeholder="field.placeholder"
                  :data-testid="`custom-field-${field.key}`"
                  class="w-full"
                />
              </UFormField>
            </template>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <UFormField :label="t('board.addTask.pipeline')">
              <PipelinePicker
                :model-value="pipelineId"
                :options="selectablePipelines"
                :none-label="t('board.addTask.chooseAtRunTime')"
                trigger-class="w-full justify-between"
                @update:model-value="pipelineId = $event"
              />
            </UFormField>

            <!-- A review task merges nothing, so its risk (merge) policy is meaningless — omit it. -->
            <UFormField v-if="!isReview" :label="t('board.addTask.mergePolicy')">
              <UDropdownMenu :items="presetMenu" class="w-full">
                <UButton
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-git-merge"
                  trailing-icon="i-lucide-chevron-down"
                  class="w-full justify-between"
                >
                  {{ selectedPresetLabel }}
                </UButton>
              </UDropdownMenu>
            </UFormField>

            <UFormField :label="t('board.addTask.modelPreset')">
              <UDropdownMenu :items="modelPresetMenu" class="w-full">
                <UButton
                  color="neutral"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-cpu"
                  trailing-icon="i-lucide-chevron-down"
                  class="w-full justify-between"
                >
                  {{ selectedModelPresetLabel }}
                </UButton>
              </UDropdownMenu>
            </UFormField>
          </div>

          <div v-if="configDescriptors.length" class="space-y-3">
            <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('board.addTask.agentConfiguration') }}
            </span>
            <div v-for="d in configDescriptors" :key="d.id" class="space-y-1">
              <div class="text-[11px] text-slate-400">{{ d.label }}</div>
              <div v-if="d.type === 'select'" class="flex flex-wrap gap-1">
                <UButton
                  v-for="opt in d.options"
                  :key="opt.value"
                  :color="configValue(d.id, d.default) === opt.value ? 'primary' : 'neutral'"
                  :variant="configValue(d.id, d.default) === opt.value ? 'soft' : 'ghost'"
                  size="xs"
                  @click="setConfig(d.id, opt.value)"
                >
                  {{ opt.label }}
                </UButton>
              </div>
              <UInput
                v-else
                :model-value="configValue(d.id, d.default)"
                :type="d.type === 'number' ? 'number' : 'text'"
                :placeholder="d.placeholder"
                size="xs"
                :data-testid="`agent-config-${d.id}`"
                @update:model-value="(v: string | number) => setConfig(d.id, String(v))"
              />
              <p class="text-[11px] leading-snug text-slate-500">{{ d.description }}</p>
            </div>
          </div>

          <!-- Best-practice fragments pinned on the task at creation, scoped to the frame's type.
               Pre-seeded from the enclosing service's standards; the task owns them from here. -->
          <div class="space-y-2">
            <FragmentSelector
              v-model="fragmentIds"
              :pool="fragmentPool"
              :label="t('board.addTask.bestPractices')"
              :empty-text="t('board.addTask.bestPracticesHint')"
            />
          </div>

          <!-- Context documents (ungated; Attach disabled until a source is connected). -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {{ t('board.addTask.contextDocuments') }}
              </span>
              <UButton
                v-if="docsConnected"
                color="neutral"
                variant="soft"
                size="xs"
                :icon="showDocPicker ? 'i-lucide-x' : 'i-lucide-plus'"
                @click="
                  () => {
                    showDocPicker = !showDocPicker
                  }
                "
              >
                {{ showDocPicker ? t('board.addTask.done') : t('board.addTask.attach') }}
              </UButton>
              <UDropdownMenu
                v-else-if="connectableDocSources.length > 1"
                :items="connectDocMenu"
                :content="{ side: 'bottom', align: 'end' }"
              >
                <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plug">
                  {{ t('board.addTask.connectSource') }}
                </UButton>
              </UDropdownMenu>
              <UButton
                v-else-if="connectableDocSources.length === 1"
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-plug"
                @click="ui.openDocumentConnect(connectableDocSources[0]!.source)"
              >
                {{
                  t('board.addTask.connectSourceNamed', { source: connectableDocSources[0]!.label })
                }}
              </UButton>
              <UButton
                v-else
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-plus"
                disabled
                :title="
                  documents.available
                    ? t('board.addTask.attachDocDisabledConnect')
                    : t('board.addTask.attachDocDisabledEnable')
                "
              >
                {{ t('board.addTask.attach') }}
              </UButton>
            </div>
            <ContextDocumentPicker
              v-if="showDocPicker && docsConnected"
              :chosen-keys="chosenDocKeys"
              @pick="addPending"
            />
            <div v-if="pendingDocs.length" class="space-y-1">
              <div
                v-for="item in pendingDocs"
                :key="contextKey(item)"
                class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
              >
                <UIcon
                  :name="item.icon ?? 'i-lucide-file-text'"
                  class="h-3.5 w-3.5 shrink-0 text-indigo-400"
                />
                <span class="truncate">{{ item.title }}</span>
                <UBadge
                  v-if="item.needsImport"
                  color="neutral"
                  variant="soft"
                  size="xs"
                  class="ms-1 shrink-0"
                >
                  {{ t('board.addTask.importsOnAdd') }}
                </UBadge>
                <button
                  type="button"
                  class="ms-auto shrink-0 text-slate-400 hover:text-slate-200"
                  @click="removePending(item)"
                >
                  <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p v-else class="text-[11px] text-slate-500">
              {{ t('board.addTask.noDocsHint') }}
            </p>
          </div>

          <!-- Context issues (ungated; Attach disabled until a tracker is connected). -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {{ t('board.addTask.contextIssues') }}
              </span>
              <UButton
                v-if="issuesConnected"
                color="neutral"
                variant="soft"
                size="xs"
                :icon="showIssuePicker ? 'i-lucide-x' : 'i-lucide-plus'"
                @click="
                  () => {
                    showIssuePicker = !showIssuePicker
                  }
                "
              >
                {{ showIssuePicker ? t('board.addTask.done') : t('board.addTask.attach') }}
              </UButton>
              <UDropdownMenu
                v-else-if="connectableIssueSources.length > 1"
                :items="connectIssueMenu"
                :content="{ side: 'bottom', align: 'end' }"
              >
                <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plug">
                  {{ t('board.addTask.connectSource') }}
                </UButton>
              </UDropdownMenu>
              <UButton
                v-else-if="connectableIssueSources.length === 1"
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-plug"
                @click="ui.openTaskConnect(connectableIssueSources[0]!.source)"
              >
                {{
                  t('board.addTask.connectSourceNamed', {
                    source: connectableIssueSources[0]!.label,
                  })
                }}
              </UButton>
              <UButton
                v-else
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-plus"
                disabled
                :title="
                  tasks.available
                    ? t('board.addTask.attachIssueDisabledConnect')
                    : t('board.addTask.attachIssueDisabledEnable')
                "
              >
                {{ t('board.addTask.attach') }}
              </UButton>
            </div>
            <ContextIssuePicker
              v-if="showIssuePicker && issuesConnected"
              :chosen-keys="chosenIssueKeys"
              :scope-block-id="ui.addTaskContainerId ?? undefined"
              @pick="addPending"
            />
            <div v-if="pendingIssues.length" class="space-y-1">
              <div
                v-for="item in pendingIssues"
                :key="contextKey(item)"
                class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
              >
                <UIcon
                  :name="item.icon ?? 'i-lucide-square-check'"
                  class="h-3.5 w-3.5 shrink-0 text-indigo-400"
                />
                <span class="truncate">{{ item.title }}</span>
                <UBadge
                  v-if="item.needsImport"
                  color="neutral"
                  variant="soft"
                  size="xs"
                  class="ms-1 shrink-0"
                >
                  {{ t('board.addTask.importsOnAdd') }}
                </UBadge>
                <button
                  type="button"
                  class="ms-auto shrink-0 text-slate-400 hover:text-slate-200"
                  @click="removePending(item)"
                >
                  <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <p v-else class="text-[11px] text-slate-500">
              {{ t('board.addTask.noIssuesHint') }}
            </p>
          </div>

          <p class="text-[11px] text-slate-500">
            {{ t('board.addTask.plannedHint') }}
          </p>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="requestClose()">{{
          t('common.cancel')
        }}</UButton>
        <UButton
          color="primary"
          data-testid="add-task-submit"
          :icon="isRecurring ? 'i-lucide-arrow-right' : 'i-lucide-plus'"
          :ui="{ leadingIcon: 'rtl:-scale-x-100', trailingIcon: 'rtl:-scale-x-100' }"
          :loading="saving"
          :disabled="!canAdd"
          @click="add"
        >
          {{ isRecurring ? t('board.addTask.continue') : t('board.addTask.submit') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
