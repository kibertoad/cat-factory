import * as v from 'valibot'

/** What a research task asks for. Apart from `research.ts` so a task's fields can name it. */
export const RESEARCH_MODES = ['initial', 'extend', 'clarify', 'refresh'] as const
export const researchModeSchema = v.picklist(RESEARCH_MODES)
export type ResearchMode = v.InferOutput<typeof researchModeSchema>
