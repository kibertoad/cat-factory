import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useInterviewDrafts } from '~/composables/useInterviewDrafts'

interface Q {
  id?: string
  key: string
  answer?: string
  status?: 'open' | 'dismissed'
}

const TITLES = { one: 'interview.saveFailed', many: 'interview.saveFailedCount' }

let present: ReturnType<typeof vi.fn>

beforeEach(() => {
  present = vi.fn()
  vi.stubGlobal('usePipelineErrorToast', () => ({ present }))
})

function harness(questions: Q[], write: (id: string, answer: string) => Promise<unknown>) {
  const list = ref<Q[]>(questions)
  const blockId = ref<string | null>('blk_1')
  const seam = useInterviewDrafts<Q>({
    blockId: () => blockId.value,
    questions: () => list.value,
    pending: () => list.value.filter((q) => !(q.answer ?? '').trim()),
    write: (_block, questionId, answer) => write(questionId, answer),
    writable: (q) => q.status !== 'dismissed',
    failureTitleKeys: TITLES,
  })
  return { ...seam, list, blockId }
}

describe('useInterviewDrafts', () => {
  it('seeds each draft from the entity and leaves an edit alone across rounds', async () => {
    const { drafts, list } = harness([{ id: 'q1', key: 'q1', answer: 'recorded' }], async () => {})
    expect(drafts.q1).toBe('recorded')

    drafts.q1 = 'the human is mid-edit'
    list.value = [
      { id: 'q1', key: 'q1', answer: 'recorded' },
      { id: 'q2', key: 'q2' },
    ]
    await nextTick()

    expect(drafts.q1).toBe('the human is mid-edit')
    expect(drafts.q2).toBe('')
  })

  it('writes only the drafts that changed, and never a question set aside', async () => {
    const written: string[] = []
    const { drafts, flushDrafts } = harness(
      [
        { id: 'q1', key: 'q1', answer: 'already this' },
        { id: 'q2', key: 'q2' },
        { id: 'q3', key: 'q3', status: 'dismissed' },
      ],
      async (id) => {
        written.push(id)
      },
    )

    drafts.q1 = 'already this'
    drafts.q2 = 'a new answer'
    drafts.q3 = 'a stale draft on a not-relevant question'
    flushDrafts()
    await vi.waitFor(() => expect(written).toEqual(['q2']))
    expect(present).not.toHaveBeenCalled()
  })

  // The defect: a sequential loop that awaited straight through abandoned every answer after the
  // first rejection, with the window already torn down and nothing left on screen to say so.
  it('keeps flushing after a failed write, then reports how many were lost', async () => {
    const attempted: string[] = []
    const { drafts, flushDrafts } = harness(
      [
        { id: 'q1', key: 'q1' },
        { id: 'q2', key: 'q2' },
        { id: 'q3', key: 'q3' },
      ],
      async (id) => {
        attempted.push(id)
        if (id !== 'q2') throw new Error(`boom ${id}`)
      },
    )

    drafts.q1 = 'one'
    drafts.q2 = 'two'
    drafts.q3 = 'three'
    flushDrafts()

    await vi.waitFor(() => expect(present).toHaveBeenCalled())
    expect(attempted).toEqual(['q1', 'q2', 'q3'])
    // The plural title, carrying the count, plus the FIRST cause so the toast's detail names a real
    // failure rather than a synthesised summary.
    expect(present).toHaveBeenCalledWith(expect.any(Error), TITLES.many, { count: 2 })
    expect((present.mock.calls[0]![0] as Error).message).toBe('boom q1')
  })

  it('reports a single lost answer with the singular title', async () => {
    const { drafts, flushDrafts } = harness([{ id: 'q1', key: 'q1' }], async () => {
      throw new Error('nope')
    })
    drafts.q1 = 'one'
    flushDrafts()

    await vi.waitFor(() => expect(present).toHaveBeenCalled())
    expect(present).toHaveBeenCalledWith(expect.any(Error), TITLES.one, { count: 1 })
  })

  it('reports a failed single save from the blur path', async () => {
    const { drafts, saveAnswer } = harness([{ id: 'q1', key: 'q1' }], async () => {
      throw new Error('nope')
    })
    drafts.q1 = 'one'
    saveAnswer({ id: 'q1', key: 'q1' })

    await vi.waitFor(() =>
      expect(present).toHaveBeenCalledWith(expect.any(Error), TITLES.one, {
        count: 1,
      }),
    )
  })

  // A missing answer may not be submitted as if it were there, and the window has to stay put so the
  // same button is still on screen with the text still in its box.
  it('withholds the action when a draft could not be written', async () => {
    const action = vi.fn().mockResolvedValue(undefined)
    const { drafts, flushThen } = harness([{ id: 'q1', key: 'q1' }], async () => {
      throw new Error('nope')
    })
    drafts.q1 = 'one'

    await flushThen(action, 'interview.continueFailed')

    expect(action).not.toHaveBeenCalled()
    expect(present).toHaveBeenCalledWith(expect.any(Error), TITLES.one, { count: 1 })
  })

  it('runs the action once every draft is written, and reports the action itself failing', async () => {
    const written: string[] = []
    const { drafts, flushThen } = harness([{ id: 'q1', key: 'q1' }], async (id) => {
      written.push(id)
    })
    drafts.q1 = 'one'

    const ok = vi.fn().mockResolvedValue(undefined)
    await flushThen(ok, 'interview.continueFailed')
    expect(written).toEqual(['q1'])
    expect(ok).toHaveBeenCalledWith('blk_1')
    expect(present).not.toHaveBeenCalled()

    // The backing stores rethrow and Vue discards a click handler's promise, so the action's own
    // failure is reported here or nowhere.
    await flushThen(
      vi.fn().mockRejectedValue(new Error('resume failed')),
      'interview.continueFailed',
    )
    expect(present).toHaveBeenCalledWith(expect.any(Error), 'interview.continueFailed')
  })

  it('writes nothing once the view has torn down and the block id is gone', async () => {
    const written: string[] = []
    const { drafts, flushDrafts, flushThen, blockId } = harness(
      [{ id: 'q1', key: 'q1' }],
      async (id) => {
        written.push(id)
      },
    )
    drafts.q1 = 'one'
    blockId.value = null

    flushDrafts()
    const action = vi.fn()
    await flushThen(action, 'interview.continueFailed')
    await nextTick()

    expect(written).toEqual([])
    expect(action).not.toHaveBeenCalled()
  })

  // An exchange with no id cannot be addressed by the answer write at all. It must not hold the
  // submit button hostage, since nothing the human types would ever clear it.
  it('excludes an unaddressable question from the unanswered count', () => {
    const { drafts, addressable, unanswered } = harness(
      [{ id: 'q1', key: 'q1' }, { key: 'q-1' }],
      async () => {},
    )

    expect(addressable({ id: 'q1', key: 'q1' })).toBe(true)
    expect(addressable({ key: 'q-1' })).toBe(false)
    expect(unanswered.value).toBe(1)

    drafts.q1 = 'answered'
    expect(unanswered.value).toBe(0)
  })
})
