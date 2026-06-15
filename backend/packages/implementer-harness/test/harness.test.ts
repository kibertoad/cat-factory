import { describe, expect, it } from 'vitest'
import { parseBootstrapJob, parseJob } from '../src/job.js'
import { parsePiOutput } from '../src/pi.js'
import { authenticatedCloneUrl } from '../src/git.js'

const validBootstrapBody = {
  systemPrompt: 'You are a bootstrapper.',
  instructions: 'Rename the service.',
  model: 'qwen3-max',
  proxyBaseUrl: 'https://w/v1',
  sessionToken: 'sess',
  ghToken: 'ght',
  reference: {
    owner: 'acme',
    name: 'service-template',
    baseBranch: 'main',
    cloneUrl: 'https://github.com/acme/service-template.git',
  },
  target: {
    owner: 'acme',
    name: 'new-service',
    cloneUrl: 'https://github.com/acme/new-service.git',
    defaultBranch: 'main',
  },
}

describe('parseBootstrapJob', () => {
  it('accepts a well-formed bootstrap job', () => {
    const job = parseBootstrapJob(validBootstrapBody)
    expect(job.reference.name).toBe('service-template')
    expect(job.target.name).toBe('new-service')
    expect(job.instructions).toBe('Rename the service.')
  })

  it('rejects missing required fields', () => {
    expect(() => parseBootstrapJob({ ...validBootstrapBody, instructions: '' })).toThrow(
      /instructions/,
    )
    expect(() => parseBootstrapJob({ ...validBootstrapBody, target: { owner: 'acme' } })).toThrow(
      /target\.name/,
    )
  })
})

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
  it('returns the last assistant message from the agent_end transcript', () => {
    const stdout = [
      '{"type":"turn_start"}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"write"}]}}',
      'not json',
      '{"type":"agent_end","messages":[' +
        '{"role":"user","content":[{"type":"text","text":"do it"}]},' +
        '{"role":"assistant","content":[{"type":"toolCall","name":"write"}]},' +
        '{"role":"toolResult","content":[{"type":"text","text":"wrote 14 bytes"}]},' +
        '{"role":"assistant","content":[{"type":"text","text":"Created IMPLEMENTED.md."}]}' +
        ']}',
    ].join('\n')
    expect(parsePiOutput(stdout)).toBe('Created IMPLEMENTED.md.')
  })

  it('falls back to message_end assistant text when there is no agent_end', () => {
    const stdout = [
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ].join('\n')
    expect(parsePiOutput(stdout)).toBe('done')
  })

  it('reads string message content', () => {
    const stdout = '{"type":"message_end","message":{"role":"assistant","content":"plain answer"}}'
    expect(parsePiOutput(stdout)).toBe('plain answer')
  })

  it('falls back to the raw tail when nothing structured matches', () => {
    expect(parsePiOutput('plain text only')).toBe('plain text only')
  })
})
