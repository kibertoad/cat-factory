import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  accountSkillSchema,
  linkSkillSourceSchema,
  skillSourceSchema,
  skillSourceStatusSchema,
  skillSyncResultSchema,
} from '../skill-library.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Repo-sourced Claude Skills route contracts. See SkillLibraryController in
// @cat-factory/server. Skills live in ONE tier (the account), so — unlike the
// fragment library — the controller is mounted only under `/accounts/:accountId`.
// Route literals are RELATIVE to that prefix; the accountId is read by the handler
// via its own param helper and is NOT a contract param.
//
// Skill ids are `src:<sourceId>:<dir>` — colon-bearing but never slash-bearing, so a
// plain `:skillId` (Hono's default `[^/]+`) matches them.
// ---------------------------------------------------------------------------

const accountSkillListSchema = v.array(accountSkillSchema)
const skillSourceListSchema = v.array(skillSourceSchema)
const sourceIdParams = singleStringParam('id')

// ---- skills (the account catalog, raw) ------------------------------------

export const listAccountSkillsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/skills',
  responsesByStatusCode: { 200: accountSkillListSchema, ...errorResponses },
})

// ---- repo sources ---------------------------------------------------------

export const listSkillSourcesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/skill-sources',
  responsesByStatusCode: { 200: skillSourceListSchema, ...errorResponses },
})

export const linkSkillSourceContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/skill-sources',
  requestBodySchema: linkSkillSourceSchema,
  responsesByStatusCode: { 201: skillSourceSchema, ...errorResponses },
})

export const unlinkSkillSourceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/skill-sources/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const skillSourceStatusContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/skill-sources/${id}/status`,
  responsesByStatusCode: { 200: skillSourceStatusSchema, ...errorResponses },
})

export const syncSkillSourceContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/skill-sources/${id}/sync`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: skillSyncResultSchema, ...errorResponses },
})
