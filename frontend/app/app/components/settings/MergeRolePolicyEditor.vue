<script setup lang="ts">
// The ROLE layer of one merge preset: what happens to a run depending on WHO started it.
//
// Three settings, edited together because they answer the same question at three strengths. A role
// can be held to stricter per-class rules than the preset's base map (`classRulesByRole`), held to
// an allowlist of the change classes it may LAND at all (`submissionClassesByRole`), or held to dry
// runs entirely (`dryRunRoles`): the pipeline works and opens its pull request, and nothing merges.
// The strongest of the three that applies is what governs, which is why a sandboxed role says so on
// its row rather than leaving the two below it reading as the policy.
//
// Composition is NARROW-ONLY, so this editor only offers a role rules STRICTER than the base one
// (see MergeRolePolicyEditor.logic.ts). A looser rule is discarded by the engine, and an editor
// that offered it would be reporting a policy that does nothing.
import { computed, ref } from 'vue'
import { RULEABLE_CHANGE_CLASSES, WORKSPACE_ROLES } from '@cat-factory/contracts'
import type {
  ClassRulesByRole,
  DryRunRoles,
  MergeClassRule,
  MergeClassRules,
  RuleableChangeClass,
  SubmissionClassesByRole,
  WorkspaceRole,
} from '~/types/merge'
import {
  INHERIT_RULE,
  roleClassRuleRows,
  roleNarrowedCount,
  roleSubmissionRows,
  roleSubmissionScoped,
  setRoleClassRule,
  setRoleSubmissionScoped,
  toggleDryRunRole,
  toggleSubmissionClass,
  type RoleRuleSelection,
} from '~/components/settings/MergeRolePolicyEditor.logic'

const props = defineProps<{
  /** The preset's per-role narrowing map; a role with no entry is exactly the base rules. */
  classRulesByRole: ClassRulesByRole
  /** The roles whose runs this preset sandboxes. */
  dryRunRoles: DryRunRoles
  /**
   * Which change classes each role may LAND. A role with no entry is unrestricted; an entry with
   * no classes lands nothing. The editor keeps those two apart (a switch, then tick boxes),
   * because tick boxes alone would render them identically.
   */
  submissionClassesByRole: SubmissionClassesByRole
  /** The base rules the role layer narrows, so each row can show what it inherits. */
  classRules: MergeClassRules
  /**
   * Whether the preset auto-merges at all. With the master switch off, every pull request already
   * waits for a human, so a role's per-class narrowing has nothing left to subtract. The SANDBOX
   * still does: it refuses the MANUAL merge too, which is the one thing the master switch leaves
   * open. The two halves of this editor therefore stop being equally meaningful, and saying so is
   * what keeps the inert half from reading as a policy that is doing something.
   */
  autoMergeEnabled: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:classRulesByRole': [ClassRulesByRole]
  'update:dryRunRoles': [DryRunRoles]
  'update:submissionClassesByRole': [SubmissionClassesByRole]
}>()

const { t } = useI18n()

// Role + class + rule labels. Exhaustive Records keyed off the contract unions (a new member fails
// the typecheck) holding LITERAL catalog keys so the typed-message-key check sees them. The role
// names are the roster's, so the two surfaces name a tier identically.
const ROLE_LABEL_KEYS: Record<WorkspaceRole, string> = {
  admin: 'layout.workspaceMembers.roles.admin',
  member: 'layout.workspaceMembers.roles.member',
  viewer: 'layout.workspaceMembers.roles.viewer',
}
const CLASS_LABEL_KEYS: Record<RuleableChangeClass, string> = {
  docs: 'merge.changeClass.docs',
  test: 'merge.changeClass.test',
  dependency: 'merge.changeClass.dependency',
  config: 'merge.changeClass.config',
  source: 'merge.changeClass.source',
  schema: 'merge.changeClass.schema',
}
const RULE_LABEL_KEYS: Record<MergeClassRule, string> = {
  thresholds: 'settings.riskPolicy.classRules.rule.thresholds',
  always: 'settings.riskPolicy.classRules.rule.always',
  never: 'settings.riskPolicy.classRules.rule.never',
}

/** Which role groups are expanded. Collapsed by default: most presets narrow nothing. */
const expanded = ref<Partial<Record<WorkspaceRole, boolean>>>({})
function toggleExpanded(role: WorkspaceRole) {
  expanded.value = { ...expanded.value, [role]: !expanded.value[role] }
}

const roles = computed(() =>
  WORKSPACE_ROLES.map((role) => {
    const entry: MergeClassRules | undefined = props.classRulesByRole[role]
    const narrowed = roleNarrowedCount(entry)
    return {
      role,
      label: t(ROLE_LABEL_KEYS[role]),
      sandboxed: props.dryRunRoles.includes(role),
      narrowed,
      open: !!expanded.value[role],
      // Scoped-ness is read off the MAP rather than off the entry being truthy, so an empty
      // allowlist (a real policy: this role lands nothing) stays scoped instead of reading as
      // the unrestricted default.
      submissionScoped: roleSubmissionScoped(props.submissionClassesByRole, role),
      submissionRows: roleSubmissionRows(props.submissionClassesByRole[role] ?? []).map((row) => ({
        ...row,
        label: t(CLASS_LABEL_KEYS[row.changeClass]),
      })),
      rows: roleClassRuleRows(props.classRules, entry).map((row) => ({
        ...row,
        label: t(CLASS_LABEL_KEYS[row.changeClass]),
        // The stored rule first (it may be one a later base edit made redundant), then whatever
        // still narrows. "Same as policy" is the absent state and always leads.
        items: [
          { value: INHERIT_RULE, label: t('settings.riskPolicy.roleRules.inherit') },
          ...row.options.map((rule) => ({ value: rule, label: t(RULE_LABEL_KEYS[rule]) })),
        ],
      })),
    }
  }),
)

/** How many classes carry a base rule stricter than nothing, for the "narrows nothing" hint. */
const anyBaseRule = computed(() =>
  RULEABLE_CHANGE_CLASSES.some((changeClass) => !!props.classRules[changeClass]),
)

function setSandboxed(role: WorkspaceRole, sandboxed: boolean) {
  emit('update:dryRunRoles', toggleDryRunRole(props.dryRunRoles, role, sandboxed))
}

function setRule(role: WorkspaceRole, changeClass: RuleableChangeClass, rule: RoleRuleSelection) {
  emit('update:classRulesByRole', setRoleClassRule(props.classRulesByRole, role, changeClass, rule))
}

function setSubmissionScoped(role: WorkspaceRole, scoped: boolean) {
  emit(
    'update:submissionClassesByRole',
    setRoleSubmissionScoped(props.submissionClassesByRole, role, scoped),
  )
}

function setSubmissionClass(
  role: WorkspaceRole,
  changeClass: RuleableChangeClass,
  allowed: boolean,
) {
  emit(
    'update:submissionClassesByRole',
    toggleSubmissionClass(props.submissionClassesByRole, role, changeClass, allowed),
  )
}
</script>

<template>
  <div data-testid="merge-role-policy" class="space-y-2">
    <div>
      <span class="block text-[10px] uppercase tracking-wide text-slate-500">
        {{ t('settings.riskPolicy.roleRules.heading') }}
      </span>
      <p class="mt-0.5 text-[11px] leading-snug text-slate-500">
        {{ t('settings.riskPolicy.roleRules.help') }}
      </p>
      <!-- Auto-merge off already sends every pull request to a human, so the per-class narrowing
           has nothing left to subtract. The other two settings still bite, because both refuse the
           MANUAL merge as well, which is the one thing the master switch leaves open. -->
      <p
        v-if="!autoMergeEnabled"
        class="mt-1 text-[11px] leading-snug text-amber-400/90"
        data-testid="merge-role-auto-merge-off"
      >
        {{ t('settings.riskPolicy.roleRules.autoMergeOffWarning') }}
      </p>
    </div>

    <div
      v-for="group in roles"
      :key="group.role"
      class="rounded-md border border-slate-700/50 bg-slate-900/30 px-2 py-1.5"
      :data-testid="`merge-role-group-${group.role}`"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="min-w-[5rem] text-xs text-slate-300">{{ group.label }}</span>
        <USwitch
          :model-value="group.sandboxed"
          size="sm"
          :disabled="disabled"
          :label="t('settings.riskPolicy.roleRules.sandboxLabel')"
          :data-testid="`merge-role-sandbox-${group.role}`"
          @update:model-value="setSandboxed(group.role, $event)"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          :icon="group.open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          :data-testid="`merge-role-expand-${group.role}`"
          @click="toggleExpanded(group.role)"
        >
          {{
            group.narrowed === 0
              ? t('settings.riskPolicy.roleRules.noRules')
              : t(
                  'settings.riskPolicy.roleRules.ruleCount',
                  { count: group.narrowed },
                  group.narrowed,
                )
          }}
        </UButton>
        <!-- A collapsed group must not hide an active policy: the tally above counts class rules
             only, and a role can land nothing at all while showing "No class limits". -->
        <span
          v-if="group.submissionScoped"
          class="text-[11px] text-amber-400/90"
          :data-testid="`merge-role-submission-badge-${group.role}`"
        >
          {{ t('settings.riskPolicy.roleRules.submissionBadge') }}
        </span>
      </div>

      <!-- A sandboxed role merges nothing at all, so neither limit below can make its runs any
           stricter. Both stay editable (removing the sandbox brings them straight back) and the
           row says which of the three is actually governing. -->
      <p
        v-if="group.sandboxed"
        class="mt-1 text-[11px] leading-snug text-amber-400/90"
        :data-testid="`merge-role-sandbox-note-${group.role}`"
      >
        {{ t('settings.riskPolicy.roleRules.sandboxNote') }}
      </p>

      <div v-if="group.open" class="mt-2 space-y-2 border-t border-slate-800 pt-2">
        <!-- What this role may LAND at all. Above the class rules because it outranks them: a
             class can be auto-mergeable under the rules and still outside this list, and then
             nothing merges, through the review card's own button included. -->
        <div class="space-y-1.5">
          <USwitch
            :model-value="group.submissionScoped"
            size="sm"
            :disabled="disabled"
            :label="t('settings.riskPolicy.roleRules.submissionLabel')"
            :data-testid="`merge-role-submission-${group.role}`"
            @update:model-value="setSubmissionScoped(group.role, $event)"
          />
          <p class="text-[11px] leading-snug text-slate-500">
            {{ t('settings.riskPolicy.roleRules.submissionHelp') }}
          </p>
          <div v-if="group.submissionScoped" class="flex flex-wrap gap-x-4 gap-y-1">
            <UCheckbox
              v-for="row in group.submissionRows"
              :key="row.changeClass"
              :model-value="row.allowed"
              size="sm"
              :disabled="disabled"
              :label="row.label"
              :data-testid="`merge-role-submission-class-${group.role}-${row.changeClass}`"
              @update:model-value="setSubmissionClass(group.role, row.changeClass, $event === true)"
            />
          </div>
          <!-- An empty allowlist is a real policy, not an unfinished edit, so it says what it
               does rather than reading as a switch somebody forgot to fill in. -->
          <p
            v-if="group.submissionScoped && !group.submissionRows.some((r) => r.allowed)"
            class="text-[11px] leading-snug text-amber-400/90"
            :data-testid="`merge-role-submission-none-${group.role}`"
          >
            {{ t('settings.riskPolicy.roleRules.submissionNone') }}
          </p>
        </div>

        <div class="space-y-1.5 border-t border-slate-800/70 pt-2">
          <p class="text-[11px] leading-snug text-slate-500">
            {{ t('settings.riskPolicy.roleRules.classHeading') }}
          </p>
          <p v-if="!anyBaseRule" class="text-[11px] leading-snug text-slate-500">
            {{ t('settings.riskPolicy.roleRules.baseHint') }}
          </p>
          <div
            v-for="row in group.rows"
            :key="row.changeClass"
            class="flex flex-wrap items-center gap-2"
            :data-testid="`merge-role-row-${group.role}-${row.changeClass}`"
          >
            <span class="min-w-[7rem] text-xs text-slate-400">{{ row.label }}</span>
            <USelect
              :model-value="row.selected"
              :items="row.items"
              value-key="value"
              size="sm"
              class="w-52"
              :disabled="disabled || row.items.length === 1"
              :data-testid="`merge-role-rule-${group.role}-${row.changeClass}`"
              @update:model-value="
                setRule(group.role, row.changeClass, $event as RoleRuleSelection)
              "
            />
            <!-- Nothing left to narrow: the base rule already routes this class to a human. -->
            <span v-if="row.items.length === 1" class="text-[11px] text-slate-500">
              {{ t('settings.riskPolicy.roleRules.alreadyStrictest') }}
            </span>
            <span
              v-else-if="row.redundant"
              class="text-[11px] text-amber-400/90"
              :data-testid="`merge-role-redundant-${group.role}-${row.changeClass}`"
            >
              {{ t('settings.riskPolicy.roleRules.redundant') }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
