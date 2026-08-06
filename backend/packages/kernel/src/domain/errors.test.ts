import { describe, expect, it } from 'vitest'
import {
  ConflictError,
  CredentialRequiredError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ReviewContendedError,
  RunContendedError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
  assertFound,
  getErrorMessage,
  getErrorReason,
} from './errors.js'

// The refusal vocabulary. `handleError` is the ONE producer of the wire envelope, and it builds
// it from exactly these fields, so what is pinned here is what a client sees: the status class in
// `code`, the machine-readable cause in `details.reason`, and a `name` that survives the throw.

describe('DomainError', () => {
  it('carries its status class, message and details', () => {
    const error = new DomainError('conflict', 'nope', { reason: 'busy' })
    expect(error.code).toBe('conflict')
    expect(error.message).toBe('nope')
    expect(error.details).toEqual({ reason: 'busy' })
    expect(error).toBeInstanceOf(Error)
  })

  it('names itself after the SUBCLASS that was constructed', () => {
    // The name is what a log line and a test assertion read; inheriting the base's would make
    // every refusal in the platform report as a bare `DomainError`.
    expect(new DomainError('validation', 'x').name).toBe('DomainError')
    expect(new ValidationError('x').name).toBe('ValidationError')
    expect(new NotFoundError('Block', 'b1').name).toBe('NotFoundError')
    expect(new ReviewContendedError('Review', 'r1').name).toBe('ReviewContendedError')
  })
})

describe('the status classes', () => {
  it('maps each class to its own code', () => {
    expect(new NotFoundError('Block', 'b1').code).toBe('not_found')
    expect(new ValidationError('bad').code).toBe('validation')
    expect(new ConflictError('busy').code).toBe('conflict')
    expect(new ForbiddenError().code).toBe('forbidden')
    expect(new UnauthorizedError().code).toBe('unauthorized')
    expect(new UnavailableError('not wired').code).toBe('unavailable')
    expect(new RateLimitedError('slow down').code).toBe('rate_limited')
    expect(
      new CredentialRequiredError('sign in', { vendor: 'claude', reason: 'password_required' })
        .code,
    ).toBe('credential_required')
  })

  it('names the entity AND the id in a not-found message', () => {
    const error = new NotFoundError('Block', 'blk_1')
    expect(error.message).toBe("Block 'blk_1' not found")
    // One endpoint can answer 404 for causes needing different reactions (an id this workspace
    // does not hold vs bytes gone from the blob backend), so the reason rides along.
    expect(new NotFoundError('Artifact', 'a1', { reason: 'blob_missing' }).details).toEqual({
      reason: 'blob_missing',
    })
    expect(error.details).toBeUndefined()
  })

  it('defaults the two "you are not allowed" classes to a coarse message', () => {
    expect(new ForbiddenError().message).toBe('Forbidden')
    expect(new UnauthorizedError().message).toBe('Unauthorized')
    expect(new ForbiddenError('workspace admin required').message).toBe('workspace admin required')
  })
})

describe('the reason a client routes on', () => {
  it('folds a conflict reason into details, merging the extra context beside it', () => {
    expect(new ConflictError('setup first', 'providers_unconfigured').details).toEqual({
      reason: 'providers_unconfigured',
    })
    expect(
      new ConflictError('setup first', 'providers_unconfigured', { models: ['a'] }).details,
    ).toEqual({ reason: 'providers_unconfigured', models: ['a'] })
  })

  it('leaves details absent for a conflict with no client-specific handling', () => {
    expect(new ConflictError('busy').details).toBeUndefined()
    // Extra context with no reason is still carried: the two are independent.
    expect(new ConflictError('busy', undefined, { blockId: 'b1' }).details).toEqual({
      blockId: 'b1',
    })
  })

  it('does the same for the 503 whose remedy is always a setup screen', () => {
    expect(new UnavailableError('no task source', 'task_source_unconfigured').details).toEqual({
      reason: 'task_source_unconfigured',
    })
    expect(new UnavailableError('no task source').details).toBeUndefined()
  })

  it('carries the retry hint in the ENVELOPE, where every hop can read it', () => {
    // A queue consumer and the durable driver read `details`; neither sees a response header.
    expect(new RateLimitedError('slow down', 'llm_quota', 30).details).toEqual({
      reason: 'llm_quota',
      retryAfterSeconds: 30,
    })
    // Zero is a real instruction ("retry immediately"), not an absent one.
    expect(new RateLimitedError('slow down', 'llm_quota', 0).details).toEqual({
      reason: 'llm_quota',
      retryAfterSeconds: 0,
    })
    expect(new RateLimitedError('slow down').details).toEqual({})
  })

  it('always states both the vendor and the reason for a credential prompt', () => {
    expect(
      new CredentialRequiredError('unlock it', { vendor: 'claude', reason: 'wrong_password' })
        .details,
    ).toEqual({ vendor: 'claude', reason: 'wrong_password' })
  })
})

describe('the contention signals', () => {
  it('keeps the run signal OFF the wire vocabulary', () => {
    // It must never reach the HTTP boundary: a leak should fail loudly rather than be mapped
    // to a status code.
    const error = new RunContendedError('ex_1')
    expect(error).not.toBeInstanceOf(DomainError)
    expect(error.name).toBe('RunContendedError')
    expect(error.message).toContain('ex_1')
  })

  it('makes the review signal a real 409, because an HTTP caller hits it too', () => {
    const error = new ReviewContendedError('Requirements review', 'rev_1')
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('conflict')
    expect(error.message).toContain('rev_1')
    expect(error.message).toContain('Requirements review')
    // No reason code: the SPA has no handling beyond "retry", which the message already says.
    expect(error.details).toBeUndefined()
  })
})

describe('assertFound', () => {
  it('passes a present value straight through, falsy ones included', () => {
    expect(assertFound('v', 'Block', 'b1')).toBe('v')
    expect(assertFound(0, 'Count', 'c1')).toBe(0)
    expect(assertFound('', 'Name', 'n1')).toBe('')
    expect(assertFound(false, 'Flag', 'f1')).toBe(false)
  })

  it('throws the 404 for a null or undefined lookup', () => {
    expect(() => assertFound(null, 'Block', 'b1')).toThrow(NotFoundError)
    expect(() => assertFound(undefined, 'Block', 'b1')).toThrow("Block 'b1' not found")
  })
})

describe('reading an unknown thrown value', () => {
  it('takes the message off an Error and stringifies anything else', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom')
    expect(getErrorMessage(new ValidationError('bad input'))).toBe('bad input')
    expect(getErrorMessage('a string throw')).toBe('a string throw')
    expect(getErrorMessage(404)).toBe('404')
    expect(getErrorMessage(null)).toBe('null')
    expect(getErrorMessage(undefined)).toBe('undefined')
  })

  it('recovers the reason code so an engine catch can propagate it un-string-matched', () => {
    expect(getErrorReason(new ConflictError('busy', 'providers_unconfigured'))).toBe(
      'providers_unconfigured',
    )
    expect(getErrorReason(new ValidationError('bad', { reason: 'no_repo' }))).toBe('no_repo')
  })

  it('reports no reason where there is none to report', () => {
    expect(getErrorReason(new ConflictError('busy'))).toBeUndefined()
    expect(getErrorReason(new Error('boom'))).toBeUndefined()
    expect(getErrorReason('a string throw')).toBeUndefined()
    // A non-string reason is not a reason: handing it on would put an object where the SPA
    // expects a code.
    expect(getErrorReason(new ValidationError('bad', { reason: { code: 1 } }))).toBeUndefined()
  })
})
