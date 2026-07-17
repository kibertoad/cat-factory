<script setup lang="ts">
// Account-tier repo-sourced Claude Skills library (docs/initiatives/repo-skills.md): a team
// authors skills in a repo (`<skill>/SKILL.md` + resources), the account syncs them into a
// catalog shared across its workspaces, and a pipeline `skill` step runs one. A body-only
// section rendered in the "Skills" tab of AccountSettingsPanel; available for ALL account types.
import SkillLibraryManager from '~/components/skills/SkillLibraryManager.vue'

const props = defineProps<{ accountId: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="space-y-6 text-sm">
    <section>
      <p class="mb-3 text-[11px] text-slate-400">
        {{ t('layout.accountSkills.intro') }}
      </p>
      <SkillLibraryManager :account-id="props.accountId" />
    </section>
  </div>
</template>
