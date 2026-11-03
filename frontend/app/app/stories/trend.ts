// Checking a stacked trend chart (`TrendColumn.vue`) by what it draws, for a story's play.
import { expect, screen } from 'storybook/test'

/**
 * Check that each column of the chart under `testId` draws at its total's share of the
 * tallest column, floored at `floorPct`, to the pixel. A column with no total draws nothing.
 * The bars once drew at zero height while every story still rendered (#2395), so a story
 * that sends trend points measures the bars rather than trusting the markup.
 */
export async function expectTrendToScale(
  testId: string,
  totals: number[],
  floorPct: number,
): Promise<void> {
  const row = await screen.findByTestId(testId)
  const rowHeight = row.getBoundingClientRect().height
  const max = Math.max(...totals)
  const drawn = [...row.children].map(
    (column) =>
      column.querySelector('[data-testid="trend-stack"]')?.getBoundingClientRect().height ?? 0,
  )
  const expected = totals.map((total) =>
    total > 0 ? (Math.max(floorPct, (total / max) * 100) * rowHeight) / 100 : 0,
  )
  expect(rowHeight).toBeGreaterThan(0)
  expect(drawn).toHaveLength(totals.length)
  drawn.forEach((height, i) => expect(height).toBeCloseTo(expected[i]!, 0))
}
