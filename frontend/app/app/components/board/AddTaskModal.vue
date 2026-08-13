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
  DescriptorFieldValues,
  DocKind,
  DocKindFieldKey,
  TaskSourceKind,
  TaskTypeFields,
} from '~/types/domain'
import { DOC_KINDS, DOC_KIND_FIELDS } from '~/types/domain'
import { resolveComponentRegistry } from '@modular-vue/core'
import { useReactiveSlots } from '@modular-vue/runtime'
import type { AppSlots, ResultViewContribution } from '~/modular/slots'
import ContextAttachmentFields from '~/components/context/ContextAttachmentFields.vue'
import DescriptorFields from '~/components/common/DescriptorFields.vue'
import FragmentSelector from '~/components/fragments/FragmentSelector.vue'
import RiskPolicyPicker from '~/components/riskPolicy/RiskPolicyPicker.vue'
import { parseConflict } from '~/composables/usePipelineErrorToast'
import { apiErrorEnvelope } from '~/composables/api/errors'
import type { ReviewTargetReason } from '@cat-factory/contracts'
import {
  defaultBuildPipelineId,
  sanitizeDescriptorFields,
  validateDescriptorFields,
} from '@cat-factory/contracts'
import { defaultDescriptorValues } from '~/utils/descriptorFields'
import { pipelineAllowedForManualStart } from '~/utils/pipeline'
import { buildTaskTypePickerRows } from '~/utils/taskTypePicker'

const ui = useUiStore()
// Interface tier. In BASIC mode this form asks for the task itself (type, title,
// description, per-type fields, context, the pipeline) and hides the OVERRIDES: the run
// knobs with a workspace-level default (merge policy, model preset), the per-task deviation
// from the service's best-practice fragments, and the technical/business hint the engine
// infers on its own. Hidden, never disabled — each one falls back to exactly the value it
// would have shown, so a basic-mode task behaves identically, it just asks less. The
// inspector's `TaskRunSettings` applies the same split after creation.
const uiMode = useUiModeStore()
const board = useBoardStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const riskPolicies = useRiskPoliciesStore()
const modelPresets = useModelPresetsStore()
const pipelines = usePipelinesStore()
const agentConfig = useAgentConfigStore()
const fragments = useFragmentsStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { t } = useI18n()

const { resolvePending, linkPending, presentLinkFailures } = useContextLinking()

const open = computed(() => ui.addTaskContainerId !== null)

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
// into `taskTypeFields.custom` on submit. Re-seeded to the descriptor's own defaults when the type
// changes / the modal reopens (its fields differ per type, so a carried-over bag would be foreign).
const customFieldValues = ref<DescriptorFieldValues>({})
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
// Client-side mirror of the server's creation check (the SAME shared function `BoardService` runs),
// so the submit button reflects an invalid form: a missing required answer, a value outside its
// declared options, an over-long string. Only the descriptor path is checked up front, since a
// bespoke `formPanel` owns its own validation and the platform cannot read its required semantics.
// The per-field path error is rendered inline by `DescriptorFields`.
const customFieldProblems = computed(() => {
  const custom = selectedCustomType.value
  if (!custom || customFormPanel.value) return []
  return validateDescriptorFields(custom.fields ?? [], customFieldValues.value)
})
// The type picker, laid out as rows (see `buildTaskTypePickerRows`): the built-in choices (i18n
// labels) first, then the deployment's registered types under their declared `presentation.category`
// captions, so a catalog of reusable operations reads as sections instead of one wall of buttons.
// Only the leftovers row's heading is CHROME, so it is the one caption the layer supplies.
const typeRows = computed(() =>
  buildTaskTypePickerRows(TASK_TYPES.value, customTaskTypes.value, {
    other: t('board.addTask.typeOther'),
  }),
)

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

// A CUSTOM (deployment-registered) task type: fold the collected values into the sparse
// `taskTypeFields.custom` bag. A bespoke form panel owns the whole bag (taken verbatim, minus blank
// entries); the descriptor path sends the SANITIZED subset (declared, currently-visible fields), so
// a stale answer on a since-hidden `showWhen` field never reaches the wire. The renderer already
// keeps each value in its contract shape, so nothing needs coercing here.
function buildCustomTypeFields(): TaskTypeFields | undefined {
  const custom = selectedCustomType.value
  if (!custom) return undefined
  let bag: DescriptorFieldValues
  if (customFormPanel.value) {
    bag = {}
    for (const [key, value] of Object.entries(customFieldValues.value)) {
      if (value !== undefined && value !== '') bag[key] = value
    }
  } else {
    bag = sanitizeDescriptorFields(custom.fields ?? [], customFieldValues.value)
  }
  return Object.keys(bag).length ? { custom: bag } : undefined
}

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
  return buildCustomTypeFields()
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

// The "pick nothing" row names the default policy it resolves to; the picker's detail pane
// explains what that policy does, so the row itself stays a bare name.
const defaultPresetLabel = computed(() =>
  riskPolicies.defaultPreset
    ? t('board.addTask.defaultPreset', { name: riskPolicies.defaultPreset.name })
    : t('board.addTask.workspaceDefault'),
)

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

// Hide UI-testing pipelines when the target frame has no UI for them to reach — a step scoped to
// a frontend service excuses itself, so this only drops an UNCONDITIONAL one (see utils/pipeline
// + the backend gate). Also hide `'recurring'`-only pipelines (a one-off task start of one is
// refused at run start) and every pipeline whose purpose doesn't match the chosen task type (a doc
// task authors a doc, a review task reviews a PR, a `bug` task ships code and may reach for a
// bugfix preset, and a `feature` gets that set minus the bugfix ones, which have no defect report
// to investigate). `blockLevel: 'task'` is passed literally because this modal only ever creates a
// task leaf, which also drops the three planning presets the backend would refuse.
// Re-filters as the chosen task type changes.
const selectablePipelines = computed(() =>
  pipelines.pipelines.filter((p) =>
    pipelineAllowedForManualStart(p, frame.value, board.blocks, taskType.value, 'task'),
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
/**
 * The pipeline a task type opens with: a custom type's registered `defaultPipelineId`, else the
 * built-in map — and for an ordinary IMPLEMENTATION task (feature / bug / chore, which the map
 * deliberately does not name), the build rung this interface mode defaults to. Basic mode gets the
 * fixed Standard build, advanced the Adaptive one; `defaultBuildPipelineId` owns that rule so the
 * create form and the task card's plain "Start" cannot disagree about it. Empty when the resolved
 * preset is not in this workspace's library (an older seed, or a retired rung).
 *
 * ONE definition, read by both the type watcher and the open-reset. They used to compute it
 * separately, the reset consulting `DEFAULT_PIPELINE_FOR_TYPE` alone and falling to `''` for every
 * implementation type — so which default a `feature` opened with depended on whether the previous
 * session had left the modal on a DIFFERENT type: same type ⇒ the watcher never fired and the
 * picker opened empty, different type ⇒ it fired (asynchronously, after the reset) and filled it in.
 */
function defaultPipelineIdFor(type: TaskTypeChoice): string {
  const custom = customTaskTypes.value.find((tt) => tt.taskType === type)
  const preset =
    custom?.defaultPipelineId ??
    DEFAULT_PIPELINE_FOR_TYPE[type] ??
    // The workspace's own declared in-app default, ahead of the interface-mode rung, so this form
    // and the task card's plain Start still cannot disagree (see `declaredDefaultId`).
    pipelines.declaredDefaultId('interactive') ??
    defaultBuildPipelineId(uiMode.isAdvanced)
  return pipelines.pipelines.some((p) => p.id === preset) ? preset : ''
}

watch(taskType, (next) => {
  const custom = customTaskTypes.value.find((tt) => tt.taskType === next)
  // A custom type owns a fresh field bag on every switch (its descriptors differ per type), seeded
  // to whatever defaults the new type declares.
  customFieldValues.value = defaultDescriptorValues(custom?.fields ?? [])
  // An unresolvable preset leaves the current selection alone rather than blanking it: a type
  // switch is an edit to a form the user is already filling in, not a reset.
  const preset = defaultPipelineIdFor(next)
  if (preset) pipelineId.value = preset
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
// its description can be shown read-only and folded into the task.
//
// Non-fatal (the form still opens), but NOT silent: an issue this cannot read is the very issue
// that will block the submit, since the fetch moved ahead of the create. Recording the cause on the
// item is what turns that into a warning the author sees NOW, on a chip they can remove, instead of
// a create refused seconds later for a reason nothing on the form ever mentioned. A tracker
// reference has no `parseRef`-style pre-flight to ask, so this attempt IS its pre-flight.
async function resolvePendingIssueBodies() {
  const unresolved = pendingContext.value.filter(
    (c) => c.kind === 'task' && !(c.description ?? '').trim(),
  )
  if (!unresolved.length) return
  resolvingIssueBodies.value = true
  try {
    const resolved: Record<string, string> = {}
    const failed: Record<string, string> = {}
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
      } catch (e) {
        failed[contextKey(item)] = e instanceof Error ? e.message : String(e)
      }
    }
    if (Object.keys(resolved).length || Object.keys(failed).length) {
      pendingContext.value = pendingContext.value.map((c) => {
        const key = contextKey(c)
        // The issue is now imported, so it links directly on add (needsImport → false).
        if (resolved[key]) return { ...c, description: resolved[key], needsImport: false }
        return failed[key] ? { ...c, unreadable: failed[key] } : c
      })
    }
  } finally {
    resolvingIssueBodies.value = false
  }
}

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
  // Empty rather than default-seeded: `taskType` was just reset to a BUILT-IN above, which
  // declares no descriptor fields. Picking a custom type from here runs the `taskType` watcher,
  // and that is the one place the new type's declared defaults are seeded.
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
  // Seed the pipeline from the (possibly doc-repo-forced) task type's default, so a document repo
  // opens with `pl_document` pre-selected and an ordinary feature with its build rung. Computed
  // through the shared helper rather than relying on the `taskType` watcher above having run: that
  // watcher fires only when the type actually CHANGED (and asynchronously, after this block), so
  // reopening the modal on the type it was last left on would otherwise open the picker empty.
  pipelineId.value = defaultPipelineIdFor(taskType.value)
  agentConfigValues.value = {}
  pendingContext.value = []
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

// The template's v-model binding: dismissal (Escape / backdrop) routes through the guard.
// Declared after the guard so the setter's `requestClose` reference is never in its TDZ.
const modalOpen = computed({
  get: () => open.value,
  set: (v: boolean) => {
    if (!v) void requestClose()
  },
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
  // A custom type's collected form must satisfy its descriptor (the same rule the server enforces).
  if (customFieldProblems.value.length > 0) return false
  return true
})

async function add() {
  if (!canAdd.value) return
  // Recurring tasks are created via a schedule on the service frame — hand off to the
  // existing recurring-pipeline modal (which carries the cadence + prompt).
  if (isRecurring.value) {
    const frameId = recurringFrameId.value
    if (!frameId) return
    ui.closeAddTask()
    ui.openAddRecurring(frameId)
    return
  }
  await submitCreate(false)
}

/**
 * Create the task, optionally acknowledging review-debt friction. A `review_debt_*` 409 opens the
 * friction dialog instead of a bare error toast: the soft `warn` tier's dialog can retry via
 * `submitCreate(true)` (the `onConfirm`), while a hard `blocked` tier only offers "Go review".
 */
async function submitCreate(acknowledgeReviewDebt: boolean) {
  const containerId = ui.addTaskContainerId
  if (!containerId) return
  saving.value = true
  try {
    // Attachments are fetched BEFORE the task is written. A page that moved, a token without
    // access or a source that is down is a correction the user can still make with the form in
    // front of them; the same failure after the create leaves a task carrying context it never
    // got, reported by a toast over a closed dialog.
    const { resolved, failures } = await resolvePending(pendingContext.value)
    pendingContext.value = resolved
    if (failures.length) {
      presentLinkFailures(failures, undefined, {
        title: (count) => t('board.addTask.contextFailed', { count }, count),
      })
      return
    }
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
      ...(acknowledgeReviewDebt ? { acknowledgeReviewDebt: true } : {}),
    })
    if (block) {
      // Everything reachable was fetched above, so what can still fail here is the LINK itself
      // (a doc another task already holds). Surfaced with its specific cause plus a one-click
      // "Copy details" for a bug report, and after the create because the task is already sound.
      presentLinkFailures(await linkPending(block.id, pendingContext.value), block.id)
    }
    ui.closeReviewFriction()
    ui.closeAddTask()
  } catch (e) {
    const conflict = parseConflict(e)
    if (conflict?.reason === 'review_debt_warn' || conflict?.reason === 'review_debt_blocked') {
      openReviewFrictionDialog(conflict)
      return
    }
    const refusal = createRefusalMessage(e)
    if (refusal) {
      toast.add({
        title: t('board.addTask.addFailedTitle'),
        description: refusal,
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    } else present(e, 'board.addTask.addFailedTitle')
  } finally {
    saving.value = false
  }
}

// The backend validates a review task's target PR against the service's repo before creating
// anything, and refuses with a machine-readable reason. Map it to translated copy here (the
// backend does not localize prose); an unrecognised failure keeps the raw message.
// Exhaustive over the closed union, so a new reason fails the typecheck rather than silently
// falling through to an English sentence from the server.
// Each message names what the user got wrong, so a detail the backend didn't send would leave a
// hole in the sentence: those cases return null and the server's own prose is shown instead.
const REVIEW_TARGET_MESSAGES: Record<
  ReviewTargetReason,
  (details: Record<string, unknown>) => string | null
> = {
  review_pr_not_found: (d) =>
    typeof d.prNumber === 'number'
      ? t('board.addTask.review.prNotFound', { number: d.prNumber })
      : null,
  review_pr_repo_mismatch: (d) =>
    typeof d.expected === 'string'
      ? t('board.addTask.review.prRepoMismatch', { repo: d.expected })
      : null,
}

/**
 * Translated copy for a machine-readable creation refusal, or null to fall back to the server's
 * own English prose. Two reasons are recognised: a review task's unresolvable target PR, and a
 * custom type's collected values contradicting its descriptor.
 *
 * The second one is reachable here even though `canAdd` mirrors the same check client-side, and
 * that is the whole point of the server-side check: the descriptor can be re-registered while this
 * dialog sits open, so the form the user filled is not the form the server now validates against.
 * The individual problems stay out of the copy: they are backend English naming field keys, so
 * what the user is told is the ONE thing they can act on (reopen the dialog).
 */
function createRefusalMessage(error: unknown): string | null {
  const details = (apiErrorEnvelope(error)?.details ?? {}) as Record<string, unknown>
  const reason = details.reason
  if (typeof reason !== 'string') return null
  if (reason === 'task_type_fields_invalid') return t('board.addTask.customFieldsInvalid')
  return REVIEW_TARGET_MESSAGES[reason as ReviewTargetReason]?.(details) ?? null
}

/** Turn a parsed review-debt friction 409 into the dialog context (see ReviewFrictionDialog.vue). */
function openReviewFrictionDialog(conflict: NonNullable<ReturnType<typeof parseConflict>>) {
  const details = conflict.details
  const rawDebt = Array.isArray(details.debt) ? details.debt : []
  const debt = rawDebt.map((d) => {
    const row = (d ?? {}) as { blockId?: unknown; title?: unknown; waitingMinutes?: unknown }
    return {
      blockId: typeof row.blockId === 'string' ? row.blockId : '',
      title: typeof row.title === 'string' ? row.title : null,
      waitingMinutes: typeof row.waitingMinutes === 'number' ? row.waitingMinutes : 0,
    }
  })
  const isWarn = conflict.reason === 'review_debt_warn'
  ui.openReviewFriction({
    kind: isWarn ? 'warn' : 'blocked',
    reason:
      details.friction === 'count' || details.friction === 'stuck' ? details.friction : undefined,
    threshold: typeof details.threshold === 'number' ? details.threshold : null,
    debt,
    onConfirm: isWarn ? () => void submitCreate(true) : null,
  })
}
</script>

<template>
  <UModal v-model:open="modalOpen" :title="t('board.addTask.title')">
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
          <!-- One row per picker group: the built-ins uncaptioned, then a caption per registered
               category, then the leftovers. Category captions are deployment-authored English
               rendered verbatim (as are the custom labels and their hover descriptions); only the
               leftovers heading is chrome, so only it is i18n. The row gap must stay WIDER than a
               caption's `mb-1`, or a heading sits equidistant between the group above it and its
               own buttons and the grouping stops reading. -->
          <div class="space-y-3">
            <div
              v-for="row in typeRows"
              :key="row.id"
              data-testid="task-type-row"
              :data-task-type-row="row.id"
            >
              <p
                v-if="row.caption"
                class="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                data-testid="task-type-category"
              >
                {{ row.caption }}
              </p>
              <div class="flex flex-wrap gap-1">
                <UButton
                  v-for="ty in row.choices"
                  :key="ty.value"
                  :color="taskType === ty.value ? 'primary' : 'neutral'"
                  :variant="taskType === ty.value ? 'soft' : 'ghost'"
                  :icon="ty.icon"
                  size="xs"
                  :title="ty.description"
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
            </div>
          </div>

          <!-- What the selected operation is for, in the deployment's own words, in the field's OWN
               help slot (the `:help` seam every other field here uses) rather than a paragraph
               beside it fighting the modal's spacing. The hover title above helps you choose; this
               states the choice you made, which is the half a touch device can reach. Built-in
               types carry no description (their labels are localized and their meaning is fixed),
               so only a custom type is described here. -->
          <template v-if="selectedCustomType?.presentation.description" #help>
            <span data-testid="task-type-description">
              {{ selectedCustomType.presentation.description }}
            </span>
          </template>
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
                data-testid="add-task-description"
              />
            </UFormField>
          </template>

          <UCheckbox v-if="uiMode.isAdvanced" v-model="technical" name="technical">
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
               `fields` the type declares, rendered by the SHARED renderer the initiative-preset form
               uses. None of the built-in `v-if` branches above match a namespaced custom type, so
               this renders on its own. -->
          <div v-if="selectedCustomType" class="space-y-3" data-testid="custom-task-fields">
            <component
              :is="customFormPanel"
              v-if="customFormPanel"
              :task-type="selectedCustomType"
              :model-value="customFieldValues"
              @update:model-value="customFieldValues = $event"
            />
            <DescriptorFields
              v-else
              v-model="customFieldValues"
              :fields="selectedCustomType.fields ?? []"
              testid-prefix="custom-field"
            />
          </div>

          <!-- One column in basic mode, where the pipeline picker is the only survivor and a
               two-column grid would leave it stranded beside an empty cell. -->
          <div class="grid gap-3" :class="uiMode.isAdvanced ? 'grid-cols-2' : 'grid-cols-1'">
            <UFormField :label="t('board.addTask.pipeline')">
              <PipelinePicker
                :model-value="pipelineId"
                :options="selectablePipelines"
                :none-label="t('board.addTask.chooseAtRunTime')"
                trigger-class="w-full justify-between"
                @update:model-value="pipelineId = $event"
              />
            </UFormField>

            <!-- A review task merges nothing, so its risk (merge) policy is meaningless — omit it.
                 Basic mode leaves it (and the model preset below) on the workspace default. -->
            <UFormField
              v-if="!isReview && uiMode.isAdvanced"
              :label="t('board.addTask.mergePolicy')"
            >
              <RiskPolicyPicker
                :model-value="riskPolicyId"
                :options="riskPolicies.presets"
                :default-policy="riskPolicies.defaultPreset"
                :none-label="defaultPresetLabel"
                trigger-class="w-full justify-between"
                @update:model-value="riskPolicyId = $event"
              />
            </UFormField>

            <UFormField v-if="uiMode.isAdvanced" :label="t('board.addTask.modelPreset')">
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
               Pre-seeded from the enclosing service's standards; the task owns them from here.
               Hidden in basic mode: `fragmentIds` still carries the service-seeded selection, so
               the task ships with its service's standards either way — advanced mode is what
               lets you deviate from them per task. -->
          <div v-if="uiMode.isAdvanced" class="space-y-2">
            <FragmentSelector
              v-model="fragmentIds"
              :pool="fragmentPool"
              :label="t('board.addTask.bestPractices')"
              :empty-text="t('board.addTask.bestPracticesHint')"
            />
          </div>

          <!-- Context documents + issues, staged here and linked once the task exists.
               Shared with the initiative create modal (ContextAttachmentFields). -->
          <ContextAttachmentFields
            v-if="ui.addTaskContainerId"
            v-model="pendingContext"
            :scope-block-id="ui.addTaskContainerId"
            :description="description"
            :docs-hint="t('board.addTask.noDocsHint')"
            :issues-hint="t('board.addTask.noIssuesHint')"
          />

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
