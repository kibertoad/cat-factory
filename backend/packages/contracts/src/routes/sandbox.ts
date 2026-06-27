import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  cloneSandboxPromptSchema,
  createSandboxExperimentSchema,
  createSandboxFixtureSchema,
  sandboxExperimentSchema,
  sandboxFixtureKindSchema,
  sandboxFixtureSchema,
  sandboxGradeSchema,
  sandboxPromptVersionSchema,
  sandboxRunSchema,
  saveSandboxVersionSchema,
  setSandboxLabelsSchema,
} from '../sandbox.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Sandbox route contracts (the parallel prompt/model testing surface). Mounted
// under `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
// See SandboxController in @cat-factory/server.
// ---------------------------------------------------------------------------

// Response wrappers that exist only inline / as service types today (the overview
// the UI loads on open and the composed experiment detail = experiment + grid).
const sandboxAgentKindMetaSchema = v.object({
  agentKind: v.string(),
  label: v.string(),
  bucket: v.string(),
  rubric: v.string(),
  fixtureKinds: v.array(sandboxFixtureKindSchema),
  basePromptId: v.nullable(v.string()),
})

const sandboxOverviewSchema = v.object({
  agentKinds: v.array(sandboxAgentKindMetaSchema),
  prompts: v.array(sandboxPromptVersionSchema),
  fixtures: v.array(sandboxFixtureSchema),
  experiments: v.array(sandboxExperimentSchema),
  maxCells: v.number(),
})

const sandboxExperimentDetailSchema = v.object({
  experiment: sandboxExperimentSchema,
  runs: v.array(sandboxRunSchema),
  grades: v.array(sandboxGradeSchema),
})

const sandboxPromptListSchema = v.array(sandboxPromptVersionSchema)
const sandboxFixtureListSchema = v.array(sandboxFixtureSchema)
const sandboxExperimentListSchema = v.array(sandboxExperimentSchema)

const promptIdParams = singleStringParam('promptId')
const fixtureIdParams = singleStringParam('fixtureId')
const experimentIdParams = singleStringParam('experimentId')

// ---- overview -------------------------------------------------------------

export const sandboxOverviewContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/sandbox/overview',
  responsesByStatusCode: { 200: sandboxOverviewSchema, ...errorResponses },
})

// ---- prompt versions ------------------------------------------------------

export const listSandboxPromptsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/sandbox/prompts',
  requestQuerySchema: v.object({ agentKind: v.optional(v.string()) }),
  responsesByStatusCode: { 200: sandboxPromptListSchema, ...errorResponses },
})

export const cloneSandboxPromptContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/sandbox/prompts/clone',
  requestBodySchema: cloneSandboxPromptSchema,
  responsesByStatusCode: { 201: sandboxPromptVersionSchema, ...errorResponses },
})

export const saveSandboxPromptContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/sandbox/prompts',
  requestBodySchema: saveSandboxVersionSchema,
  responsesByStatusCode: { 201: sandboxPromptVersionSchema, ...errorResponses },
})

export const setSandboxPromptLabelsContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: promptIdParams,
  pathResolver: ({ promptId }) => `/sandbox/prompts/${promptId}/labels`,
  requestBodySchema: setSandboxLabelsSchema,
  responsesByStatusCode: { 200: sandboxPromptVersionSchema, ...errorResponses },
})

export const archiveSandboxPromptContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: promptIdParams,
  pathResolver: ({ promptId }) => `/sandbox/prompts/${promptId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- fixtures -------------------------------------------------------------

export const listSandboxFixturesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/sandbox/fixtures',
  responsesByStatusCode: { 200: sandboxFixtureListSchema, ...errorResponses },
})

export const createSandboxFixtureContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/sandbox/fixtures',
  requestBodySchema: createSandboxFixtureSchema,
  responsesByStatusCode: { 201: sandboxFixtureSchema, ...errorResponses },
})

export const removeSandboxFixtureContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: fixtureIdParams,
  pathResolver: ({ fixtureId }) => `/sandbox/fixtures/${fixtureId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- experiments ----------------------------------------------------------

export const listSandboxExperimentsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/sandbox/experiments',
  responsesByStatusCode: { 200: sandboxExperimentListSchema, ...errorResponses },
})

export const createSandboxExperimentContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/sandbox/experiments',
  requestBodySchema: createSandboxExperimentSchema,
  responsesByStatusCode: { 201: sandboxExperimentSchema, ...errorResponses },
})

export const getSandboxExperimentContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: experimentIdParams,
  pathResolver: ({ experimentId }) => `/sandbox/experiments/${experimentId}`,
  responsesByStatusCode: { 200: sandboxExperimentDetailSchema, ...errorResponses },
})

export const launchSandboxExperimentContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: experimentIdParams,
  pathResolver: ({ experimentId }) => `/sandbox/experiments/${experimentId}/launch`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: sandboxExperimentDetailSchema, ...errorResponses },
})
