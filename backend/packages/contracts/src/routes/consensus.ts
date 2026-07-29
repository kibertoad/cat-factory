import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  consensusGroupSchema,
  consensusSessionSchema,
  createConsensusGroupSchema,
  updateConsensusGroupSchema,
} from '../consensus.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Consensus route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. Two surfaces: the read-only session
// transcript (always 200s with `{ session: null }` when consensus is off or no
// session has run), and CRUD over the workspace's consensus-GROUP library — the
// reusable, estimate-gated panels a pipeline step escalates to. See
// ConsensusController / ConsensusGroupController in @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')
const groupIdParams = singleStringParam('groupId')

/** The `{ session }` envelope the read route returns (session null when none). */
const consensusSessionResponseSchema = v.object({
  session: v.nullable(consensusSessionSchema),
})

export const getConsensusSessionContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/consensus-session`,
  responsesByStatusCode: { 200: consensusSessionResponseSchema, ...errorResponses },
})

// ---- The consensus-group library ------------------------------------------

const consensusGroupListSchema = v.array(consensusGroupSchema)

export const listConsensusGroupsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/consensus-groups',
  responsesByStatusCode: { 200: consensusGroupListSchema, ...errorResponses },
})

export const createConsensusGroupContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/consensus-groups',
  requestBodySchema: createConsensusGroupSchema,
  responsesByStatusCode: { 201: consensusGroupSchema, ...errorResponses },
})

export const updateConsensusGroupContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: groupIdParams,
  pathResolver: ({ groupId }) => `/consensus-groups/${groupId}`,
  requestBodySchema: updateConsensusGroupSchema,
  responsesByStatusCode: { 200: consensusGroupSchema, ...errorResponses },
})

export const deleteConsensusGroupContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: groupIdParams,
  pathResolver: ({ groupId }) => `/consensus-groups/${groupId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
