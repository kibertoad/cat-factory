import { describe, expect, it } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { describeCallbackFailure } from '~/components/settings/McpOAuthCallbackScreen.logic'

const formatRequestId = (id: string) => `Request ID ${id}`

describe('describeCallbackFailure', () => {
  // The API client keeps the envelope on `ApiError.body`. The page used to read `.data`, which an
  // `ApiError` does not have, so every refusal showed the generic line (#2396).
  it('reads the refusal from the envelope on ApiError.body', () => {
    const error = new ApiError(403, {
      error: {
        code: 'forbidden',
        message: 'This action requires the secrets.manage permission',
        requestId: 'req-42',
      },
    })

    expect(describeCallbackFailure(error, formatRequestId)).toEqual({
      descriptionKey: 'errors.generic.description.forbidden',
      detail: 'This action requires the secrets.manage permission · Request ID req-42',
    })
  })

  it('maps a reason with its own copy ahead of the status class', () => {
    const error = new ApiError(503, {
      error: {
        code: 'unavailable',
        message: 'Could not read the credentials',
        details: { reason: 'connection_credentials_unreadable' },
      },
    })

    expect(describeCallbackFailure(error, formatRequestId).descriptionKey).toBe(
      'errors.unavailable.description.connection_credentials_unreadable',
    )
  })

  it('describes a request that reached no server as a network fault', () => {
    expect(describeCallbackFailure(new TypeError('Failed to fetch'), formatRequestId)).toEqual({
      descriptionKey: 'errors.generic.description.network',
      detail: 'Failed to fetch',
    })
  })
})
