/**
 * The named overlay widths (#2251). A dialog names the KIND of content it holds, not a width:
 *
 * - `prompt` (448px): a confirmation, a decision, a short read, or a dialog with one or two fields.
 * - `form` (576px): a form, a list or a hub to work through.
 * - `wide` (672px): cards that each carry a paragraph and an action beside it, a row of tabs over
 *   a form, or three pickers side by side (the AI provider onboarding, the vendor credentials, the
 *   setup checklist, describe new work).
 *
 * A workbench surface (the sandbox, the agent prompt editor, the pipeline builder, the libraries
 * and settings panels) is wider than `wide` on purpose and keeps its literal width until #2359
 * decides its shell; it says so with a `workbench-width-ok:` comment that
 * `scripts/check-frontend-geometry.mjs` reads. A `Record` over the union, so a new size fails to
 * compile until it is mapped.
 */
export type OverlaySize = 'prompt' | 'form' | 'wide'

export const OVERLAY_WIDTH_CLASS: Record<OverlaySize, string> = {
  prompt: 'max-w-md',
  form: 'max-w-xl',
  wide: 'max-w-2xl',
}
