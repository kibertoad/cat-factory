<script setup lang="ts">
// Edits a `Recurrence`: run every N hours, optionally constrained to a set of
// weekdays and an hour-of-day window, in a chosen timezone. Used both when adding
// a recurring pipeline (frame modal) and when editing one (inspector). Emits the
// updated recurrence via v-model.
import type { Recurrence } from '~/types/recurring'

const props = defineProps<{ modelValue: Recurrence }>()
const emit = defineEmits<{ 'update:modelValue': [Recurrence] }>()

const WEEKDAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
]

function patch(p: Partial<Recurrence>) {
  emit('update:modelValue', { ...props.modelValue, ...p })
}

function toggleDay(day: number) {
  const set = new Set(props.modelValue.weekdays)
  if (set.has(day)) set.delete(day)
  else set.add(day)
  patch({ weekdays: [...set].sort((a, b) => a - b) })
}

// The hour-window is "any hour" when both bounds are null. The checkbox toggles
// between unconstrained and a default business-hours window.
const windowEnabled = computed(
  () => props.modelValue.windowStartHour !== null || props.modelValue.windowEndHour !== null,
)
function toggleWindow(enabled: boolean) {
  if (enabled) patch({ windowStartHour: 9, windowEndHour: 17 })
  else patch({ windowStartHour: null, windowEndHour: null })
}

const hours = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${String(h).padStart(2, '0')}:00`,
}))

// A small, common set of IANA zones plus whatever the schedule already uses.
const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Helsinki',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Tokyo',
]
const timezoneOptions = computed(() =>
  Array.from(new Set([props.modelValue.timezone, ...TIMEZONES])),
)
</script>

<template>
  <div class="space-y-3">
    <UFormField label="Run every">
      <div class="flex items-center gap-2">
        <UInput
          :model-value="modelValue.intervalHours"
          type="number"
          :min="1"
          class="w-24"
          @update:model-value="patch({ intervalHours: Math.max(1, Number($event) || 1) })"
        />
        <span class="text-xs text-slate-400">hours</span>
      </div>
    </UFormField>

    <UFormField label="Allowed days" help="Leave all off to run any day.">
      <div class="flex flex-wrap gap-1">
        <UButton
          v-for="d in WEEKDAYS"
          :key="d.value"
          size="xs"
          :color="modelValue.weekdays.includes(d.value) ? 'primary' : 'neutral'"
          :variant="modelValue.weekdays.includes(d.value) ? 'solid' : 'subtle'"
          @click="toggleDay(d.value)"
        >
          {{ d.label }}
        </UButton>
      </div>
    </UFormField>

    <UFormField>
      <UCheckbox
        :model-value="windowEnabled"
        label="Only within an hour-of-day window (e.g. business hours)"
        @update:model-value="toggleWindow(Boolean($event))"
      />
    </UFormField>

    <div v-if="windowEnabled" class="flex items-center gap-2">
      <USelect
        :model-value="modelValue.windowStartHour ?? 0"
        :items="hours"
        class="w-28"
        @update:model-value="patch({ windowStartHour: Number($event) })"
      />
      <span class="text-xs text-slate-400">to</span>
      <USelect
        :model-value="modelValue.windowEndHour ?? 24 % 24"
        :items="hours"
        class="w-28"
        @update:model-value="patch({ windowEndHour: Number($event) })"
      />
    </div>

    <UFormField label="Timezone">
      <USelect
        :model-value="modelValue.timezone"
        :items="timezoneOptions"
        class="w-full"
        @update:model-value="patch({ timezone: String($event) })"
      />
    </UFormField>
  </div>
</template>
