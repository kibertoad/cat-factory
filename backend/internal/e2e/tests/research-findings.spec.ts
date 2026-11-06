import { test, expect } from './fixtures'
import {
  BACKEND_URL,
  LIVE_TIMEOUT,
  RUN_TERMINAL_TIMEOUT,
  setFakeProfile,
  taskCard,
} from './helpers'

// A research project's findings reader, end to end: a research project pinned over REST, the
// reader opened from the project frame, a follow-up started through the reader's own form, and
// the findings the run records read back live once the run settles. The run is the deterministic
// fake researcher, which answers every question it is handed.
test.describe('research findings', () => {
  test('start research from the reader and read the recorded findings back', async ({
    page,
    request,
    seededBoard,
  }) => {
    const { workspaceId } = seededBoard
    // The run under test is the research step itself, so no decision park in front of it.
    await setFakeProfile(request, workspaceId, { decisionOnSteps: [] })
    const created = await request.post(`${BACKEND_URL}/workspaces/${workspaceId}/projects`, {
      data: {
        kind: 'research',
        title: 'Vendor research',
        research: { definitionKey: 'e2e:vendor' },
        position: { x: 1200, y: 80 },
      },
    })
    expect(created.status()).toBe(201)
    const { project } = (await created.json()) as {
      project: { id: string; rootBlockId: string }
    }

    const frame = taskCard(page, project.rootBlockId)
    await expect(frame).toBeVisible({ timeout: LIVE_TIMEOUT })
    await frame.getByTestId('project-open-findings').click()

    const reader = page.getByTestId('research-findings')
    await expect(reader).toBeVisible()
    await expect(reader.getByTestId('research-pin')).toContainText('version 1')
    // Nothing answered yet, and the definition's credential is not stored on this board.
    await expect(reader.getByTestId('research-finding')).toHaveCount(2)
    await expect(reader.getByTestId('research-finding-status').first()).toHaveText('Unanswered')

    await reader.getByTestId('research-start-follow-up').click()
    const form = page.getByTestId('research-follow-up')
    await expect(form).toBeVisible()
    await page.getByTestId('research-follow-up-submit').click()
    await expect(form).toBeHidden({ timeout: LIVE_TIMEOUT })

    // The run settles and the reader re-reads the project: both questions answered, and the
    // revision the task wrote is in the history with where its body lives.
    await expect(reader.getByTestId('research-finding-status')).toHaveText(
      ['Answered', 'Answered'],
      {
        timeout: RUN_TERMINAL_TIMEOUT,
      },
    )
    await reader.getByRole('tab', { name: 'History' }).click()
    await expect(reader.getByTestId('research-revision')).toHaveCount(1)
    await expect(reader.getByTestId('research-revision-storage')).toContainText('Stored inline')

    await reader.getByRole('tab', { name: /Credentials/ }).click()
    await expect(reader.getByTestId('research-credential-status')).toHaveText('Missing')
  })
})
