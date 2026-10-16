// Plays for the inspector's collapsible sections. A section mounts closed, so a story that shows
// its content opens it first and then waits for what it is named after.
import { userEvent, within } from 'storybook/test'

/** Open the section the story renders, once it mounts: some sections wait for their data. */
export async function openSection(canvasElement: HTMLElement): Promise<void> {
  await userEvent.click(await within(canvasElement).findByTestId('inspector-section-toggle'))
}

/** A play that opens the section, then waits for what the story shows. */
export function opensTo(shown: (canvas: ReturnType<typeof within>) => Promise<unknown>) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await openSection(canvasElement)
    await shown(within(canvasElement))
  }
}
