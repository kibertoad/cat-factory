import { describe, expect, it } from 'vitest'
import { parseJob } from '../src/job.js'
import { parsePiOutput } from '../src/pi.js'
import { authenticatedCloneUrl } from '../src/git.js'

const validBody = {
  systemPrompt: 'You are a builder.',
  userPrompt: 'Implement the thing.',
  model: 'qwen3-max',
  proxyBaseUrl: 'https://w/v1',
  sessionToken: 'sess',
  ghToken: 'ght',
  repo: { owner: 'o', name: 'r', baseBranch: 'main', cloneUrl: 'https://github.com/o/r.git' },
  headBranch: 'cat-factory/blk-1',
  pr: { title: 'T', body: 'B' },
}

describe('parseJob', () => {
  it('accepts a well-formed job', () => {
    const job = parseJob(validBody)
    expect(job.repo.owner).toBe('o')
    expect(job.pr.title).toBe('T')
  })

  it('defaults an absent pr body to empty', () => {
    const job = parseJob({ ...validBody, pr: { title: 'T' } })
    expect(job.pr.body).toBe('')
  })

  it('rejects missing required fields', () => {
    expect(() => parseJob({ ...validBody, sessionToken: '' })).toThrow(/sessionToken/)
    expect(() => parseJob({ ...validBody, repo: { owner: 'o' } })).toThrow(/repo\.name/)
    expect(() => parseJob(null)).toThrow(/object/)
  })
})

describe('authenticatedCloneUrl', () => {
  it('injects the token as x-access-token', () => {
    expect(authenticatedCloneUrl('https://github.com/o/r.git', 'TOK')).toBe(
      'https://x-access-token:TOK@github.com/o/r.git',
    )
  })
})

describe('parsePiOutput', () => {
  it('collects assistant text from JSON-lines events', () => {
    const stdout = [
      '{"type":"tool","name":"bash"}',
      '{"type":"assistant","text":"Implemented the limiter."}',
      '{"type":"assistant","content":[{"text":" Added tests."}]}',
      'not json',
    ].join('\n')
    expect(parsePiOutput(stdout)).toBe('Implemented the limiter.\n Added tests.')
  })

  it('falls back to the raw tail when nothing structured matches', () => {
    expect(parsePiOutput('plain text only')).toBe('plain text only')
  })

  it('reads message.content shape', () => {
    const stdout = '{"type":"message","message":{"content":"done"}}'
    expect(parsePiOutput(stdout)).toBe('done')
  })
})
