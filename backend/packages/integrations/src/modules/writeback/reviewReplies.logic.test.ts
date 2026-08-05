import { describe, expect, it } from 'vitest'
import {
  isAllowedReplyAuthor,
  isPlatformAuthoredComment,
  parseReviewReplyCommands,
  renderReviewReplyAck,
} from './reviewReplies.logic.js'
import { renderReviewQuestionsComment } from './reviewQuestions.logic.js'
import type { ReviewReplyAck, TrackerCommentAuthor } from '@cat-factory/kernel'

const author = (over: Partial<TrackerCommentAuthor> = {}): TrackerCommentAuthor => ({
  id: 'u1',
  handle: 'reporter',
  email: 'reporter@acme.test',
  bot: false,
  ...over,
})

describe('parseReviewReplyCommands', () => {
  it('returns nothing for ordinary discussion, so a thread does not become a bot conversation', () => {
    expect(parseReviewReplyCommands('I think a month is about right, maybe two?')).toEqual([])
    expect(parseReviewReplyCommands('')).toEqual([])
  })

  it('interprets only lines whose FIRST token is the trigger', () => {
    // A mid-sentence mention is discussion, not an instruction — which is exactly the case that
    // makes natural-language matching unsafe: "ask @cat-factory answer rri_1 …" is a human talking
    // ABOUT the bot, not to it.
    const commands = parseReviewReplyCommands(
      [
        'someone should ask @cat-factory answer rri_1 to do this',
        '@cat-factory dismiss rri_2',
      ].join('\n'),
    )
    expect(commands).toEqual([
      { verb: 'dismiss', itemId: 'rri_2', line: '@cat-factory dismiss rri_2' },
    ])
  })

  it('requires a token boundary, so `@cat-factory-bot` is not read as a command', () => {
    expect(parseReviewReplyCommands('@cat-factory-bot answer rri_1 nope')).toEqual([])
  })

  it('captures an answer to the end of the line, preserving the writer’s spacing', () => {
    const commands = parseReviewReplyCommands('@cat-factory answer rri_1  30 days,  not 30 hours.')
    expect(commands).toEqual([
      {
        verb: 'answer',
        itemId: 'rri_1',
        text: '30 days,  not 30 hours.',
        line: '@cat-factory answer rri_1  30 days,  not 30 hours.',
      },
    ])
  })

  it('locates the answer AFTER the verb, not at the id’s first occurrence anywhere', () => {
    // `answer a …` used to find the `a` of `answer` and take the rest of that word as the answer.
    // Short ids that happen to be a substring of a verb are entirely legitimate, so the offset has
    // to be computed past the verb rather than searched for.
    expect(parseReviewReplyCommands('@cat-factory answer a 30 days')[0]).toMatchObject({
      itemId: 'a',
      text: '30 days',
    })
    // …and an answer with no text at all stays EMPTY, so the caller can reject it rather than
    // storing a fragment of the command as if it were a human's words.
    expect(parseReviewReplyCommands('@cat-factory answer a')[0]).toMatchObject({
      itemId: 'a',
      text: '',
    })
  })

  it('continues a multi-line answer until the next trigger line', () => {
    const commands = parseReviewReplyCommands(
      [
        '@cat-factory answer rri_1 Two things:',
        '- sessions last 30 days',
        '- refresh extends them',
        '@cat-factory dismiss rri_2',
        'thanks!',
      ].join('\n'),
    )
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({
      verb: 'answer',
      itemId: 'rri_1',
      text: 'Two things:\n- sessions last 30 days\n- refresh extends them',
    })
    expect(commands[1]).toMatchObject({ verb: 'dismiss', itemId: 'rri_2' })
  })

  it('parses the three cap choices, accepting either spelling of extra-round', () => {
    expect(parseReviewReplyCommands('@cat-factory proceed')[0]).toMatchObject({ verb: 'proceed' })
    expect(parseReviewReplyCommands('@cat-factory stop')[0]).toMatchObject({ verb: 'stop' })
    expect(parseReviewReplyCommands('@cat-factory extra-round')[0]).toMatchObject({
      verb: 'extra-round',
    })
    expect(parseReviewReplyCommands('@cat-factory extra_round')[0]).toMatchObject({
      verb: 'extra-round',
    })
  })

  it('reports an unknown verb and a missing item id rather than dropping them', () => {
    // D4: a reporter who typed something almost-right and heard nothing back would reasonably
    // conclude the whole mechanism is broken.
    const commands = parseReviewReplyCommands(
      ['@cat-factory reply rri_1 here you go', '@cat-factory answer', '@cat-factory dismiss'].join(
        '\n',
      ),
    )
    expect(commands.map((c) => c.verb)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  it('is case-insensitive on the trigger and the verb', () => {
    expect(parseReviewReplyCommands('@CAT-FACTORY DISMISS rri_1')[0]).toMatchObject({
      verb: 'dismiss',
      itemId: 'rri_1',
    })
  })

  it('ignores a BARE mention — tagging the bot is discussion, not a malformed command', () => {
    // A non-empty command list drives the whole ingest (projection read, review read, a consumed
    // claim) and ends in a follow-up telling a human who asked a question that their "command" was
    // unrecognised. A trigger with no verb after it is not an attempt at a command at all.
    expect(parseReviewReplyCommands('@cat-factory')).toEqual([])
    expect(parseReviewReplyCommands('  @cat-factory  ')).toEqual([])
    expect(parseReviewReplyCommands('@cat-factory\n@cat-factory')).toEqual([])
  })

  it('still REPORTS a near-miss at a real command (D4)', () => {
    // The line between the two: `reply` is someone reaching for `answer` and getting it wrong, and
    // hearing nothing back would read as the whole mechanism being broken.
    expect(parseReviewReplyCommands('@cat-factory reply rri_1 yes')).toEqual([
      { verb: 'unknown', line: '@cat-factory reply rri_1 yes' },
    ])
  })

  it('bounds a pathological paste', () => {
    const many = Array.from({ length: 500 }, (_, i) => `@cat-factory dismiss rri_${i}`).join('\n')
    expect(parseReviewReplyCommands(many).length).toBeLessThanOrEqual(50)
  })
})

describe('isPlatformAuthoredComment', () => {
  // The structural half of the self-comment guard. The author-side bot flag covers GitHub and
  // Jira, but Linear flags no bots and the default allow-list admits any author — so on Linear our
  // own acknowledgement is an allowed author on an issue we are linked to. Today no loop results
  // only because no ack line happens to start with the trigger; that is an invariant across two
  // renderers enforced by nothing, and a loop (fresh comment id every time, so the ingest claim
  // cannot stop it) is a far worse failure than the duplicate it would look like.
  it('recognises BOTH platform-authored comment renderers', () => {
    const ack = renderReviewReplyAck({
      subject: 'requirements',
      reviewId: 'rrv_1',
      runId: 'run_1',
      outcome: 'awaiting',
      answered: ['rri_1'],
      dismissed: [],
      outstanding: [{ id: 'rri_2', title: 'Which region?', detail: 'd' }],
      rejected: [],
    })
    expect(isPlatformAuthoredComment(ack)).toBe(true)

    const questions = renderReviewQuestionsComment({
      workspaceId: 'ws1',
      subject: 'requirements',
      reviewId: 'rrv_1',
      iteration: 1,
      maxIterations: 3,
      issueRef: 'jira:ENG-1',
      runId: 'run_1',
      findings: [{ id: 'rri_2', title: 'Which region?', detail: 'd' }],
    } as never)
    expect(isPlatformAuthoredComment(questions)).toBe(true)
  })

  it('does not mistake a human comment for one of ours', () => {
    expect(isPlatformAuthoredComment('@cat-factory answer rri_1 eu-west-1')).toBe(false)
    expect(isPlatformAuthoredComment('')).toBe(false)
    // A human QUOTING our comment further down still gets their reply read: only the first
    // non-blank line decides, so the guard cannot be used to silence someone else's answer.
    expect(isPlatformAuthoredComment('@cat-factory answer rri_1 yes\n\n> 🤖 as you said')).toBe(
      false,
    )
  })

  it('tolerates leading blank lines, which trackers add freely', () => {
    expect(isPlatformAuthoredComment('\n\n  🤖 Thanks — that answers everything.')).toBe(true)
  })
})

describe('isAllowedReplyAuthor', () => {
  it('never allows a bot, even when the allow-list would match', () => {
    // The platform's own acknowledgement comes back as a delivery; without this it feeds itself.
    expect(isAllowedReplyAuthor(author({ bot: true }), '')).toBe(false)
    expect(isAllowedReplyAuthor(author({ bot: true }), 'reporter')).toBe(false)
  })

  it('allows any non-bot author when no allow-list is configured', () => {
    expect(isAllowedReplyAuthor(author(), '')).toBe(true)
    expect(isAllowedReplyAuthor(author(), '   ')).toBe(true)
  })

  it('matches an allow-list entry against handle, email or vendor id, case-insensitively', () => {
    expect(isAllowedReplyAuthor(author(), 'someone-else, REPORTER')).toBe(true)
    expect(isAllowedReplyAuthor(author(), 'Reporter@Acme.test')).toBe(true)
    expect(isAllowedReplyAuthor(author(), 'u1')).toBe(true)
    expect(isAllowedReplyAuthor(author(), 'someone-else')).toBe(false)
  })

  it('does not let a null identity match an empty-ish allow-list entry', () => {
    // A stray trailing comma must not turn into a wildcard for an author whose handle is unknown.
    expect(isAllowedReplyAuthor(author({ handle: null, email: null, id: null }), 'alice,')).toBe(
      false,
    )
  })
})

describe('renderReviewReplyAck', () => {
  const base: ReviewReplyAck = {
    subject: 'requirements',
    reviewId: 'rrv_1',
    runId: 'run_1',
    outcome: 'awaiting',
    answered: ['rri_1'],
    dismissed: [],
    outstanding: [{ id: 'rri_2', title: 'Retention window', detail: 'How long?' }],
    rejected: [],
  }

  it('names what was applied and what is still outstanding, with the ids a reply must use', () => {
    const body = renderReviewReplyAck(base)
    expect(body).toContain('`rri_1`')
    expect(body).toContain('`rri_2`')
    expect(body).toContain('Still open')
    expect(body).toContain('@cat-factory answer <id>')
  })

  it('states the three options at the iteration cap, and does not imply an auto-proceed', () => {
    const body = renderReviewReplyAck({ ...base, outcome: 'exceeded', outstanding: [] })
    expect(body).toContain('@cat-factory proceed')
    expect(body).toContain('@cat-factory extra-round')
    expect(body).toContain('@cat-factory stop')
  })

  it('says the review already moved on rather than pretending the reply landed', () => {
    const body = renderReviewReplyAck({
      ...base,
      outcome: 'settled',
      answered: [],
      outstanding: [],
    })
    expect(body).toContain('already moved on')
  })

  it('reports rejected commands instead of silently ignoring them', () => {
    const body = renderReviewReplyAck({
      ...base,
      rejected: [{ command: '@cat-factory reply rri_9 hi', reason: 'unrecognised command' }],
    })
    expect(body).toContain('Not applied')
    expect(body).toContain('unrecognised command')
  })

  it('neutralises host auto-link triggers in untrusted finding text', () => {
    // A tracker issue is a host-parsed, often PUBLIC surface: `@alice` pages a real account and
    // `#42` cross-links an unrelated issue. Finding titles are model-authored prose derived from a
    // customer's description, so they cross the same boundary the question comment does.
    const body = renderReviewReplyAck({
      ...base,
      outstanding: [{ id: 'rri_2', title: 'Ask @alice about #42', detail: 'x' }],
    })
    expect(body).not.toContain('@alice')
    expect(body).not.toContain('#42')
    // The id itself is platform-minted, so it stays verbatim — it is what the next reply names.
    expect(body).toContain('`rri_2`')
  })

  it('scrubs a secret pasted into a finding before it is republished', () => {
    const body = renderReviewReplyAck({
      ...base,
      outstanding: [
        {
          id: 'rri_2',
          title: 'Use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          detail: 'x',
        },
      ],
    })
    expect(body).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  })
})
