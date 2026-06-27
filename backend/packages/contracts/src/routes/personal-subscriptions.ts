import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  personalSubscriptionStatusSchema,
  storePersonalSubscriptionSchema,
} from '../personal-subscriptions.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-USER individual-usage subscription route contracts. Scoped to the
// signed-in user (not a workspace) and mounted at the root, so the paths here
// are absolute. See PersonalSubscriptionController in @cat-factory/server.
// ---------------------------------------------------------------------------

// Response wrapper that exists only inline in the controller today.
const personalSubscriptionsViewSchema = v.object({
  subscriptions: v.array(personalSubscriptionStatusSchema),
})

const vendorParams = withObjectKeys(v.object({ vendor: v.string() }))

export const listPersonalSubscriptionsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/personal-subscriptions',
  responsesByStatusCode: { 200: personalSubscriptionsViewSchema, ...errorResponses },
})

export const storePersonalSubscriptionContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/personal-subscriptions',
  requestBodySchema: storePersonalSubscriptionSchema,
  responsesByStatusCode: { 201: personalSubscriptionStatusSchema, ...errorResponses },
})

export const removePersonalSubscriptionContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: vendorParams,
  pathResolver: ({ vendor }) => `/personal-subscriptions/${vendor}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
