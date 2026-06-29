import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { blockSchema } from '../entities.js'
import {
  connectTaskSourceSchema,
  createTaskFromIssueSchema,
  importTaskSchema,
  linearTeamSchema,
  linkTaskSchema,
  searchTasksSchema,
  setTaskSourceEnabledSchema,
  sourceTaskSchema,
  spawnEpicSchema,
  taskConnectionSchema,
  taskSearchResultSchema,
  taskSourceDiagnosticSchema,
  taskSourceStateSchema,
} from '../tasks.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Task-source route contracts: source discovery + per-workspace toggle,
// connection management, live diagnostics, issue import/listing, linking an
// issue to a block as agent context, materialising an issue as a board task,
// and spawning an epic. Mounted under `/workspaces/:workspaceId`, so the paths
// here are relative to that prefix. See TaskSourceController.
// ---------------------------------------------------------------------------

const sourceParams = singleStringParam('source')

// Response wrappers that exist only inline in the controller today.
const taskSourcesViewSchema = v.object({
  sources: v.array(taskSourceStateSchema),
})
const taskConnectionsViewSchema = v.object({
  connections: v.array(taskConnectionSchema),
})
const taskListSchema = v.array(sourceTaskSchema)
const taskSearchResultsViewSchema = v.object({
  results: v.array(taskSearchResultSchema),
})
const createTaskFromIssueResultSchema = v.object({
  block: blockSchema,
  task: sourceTaskSchema,
})
const spawnEpicResultSchema = v.object({
  epic: blockSchema,
  tasks: v.array(blockSchema),
})
const linearTeamsViewSchema = v.object({
  teams: v.array(linearTeamSchema),
})
const linearInstallUrlViewSchema = v.object({
  url: v.string(),
})

export const listTaskSourcesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/task-sources',
  responsesByStatusCode: { 200: taskSourcesViewSchema, ...errorResponses },
})

export const setTaskSourceEnabledContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/task-sources/${source}/enabled`,
  requestBodySchema: setTaskSourceEnabledSchema,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const listTaskConnectionsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/task-sources/connections',
  responsesByStatusCode: { 200: taskConnectionsViewSchema, ...errorResponses },
})

export const connectTaskSourceContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/task-sources/${source}/connect`,
  requestBodySchema: connectTaskSourceSchema,
  responsesByStatusCode: { 201: taskConnectionSchema, ...errorResponses },
})

export const disconnectTaskSourceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/task-sources/${source}/connection`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const diagnoseTaskSourceContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/task-sources/${source}/diagnostics`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: taskSourceDiagnosticSchema, ...errorResponses },
})

// Linear-specific: list the connection's teams (for the ticket-filing team picker)
// and start the OAuth "Connect with Linear" flow (returns the authorize URL).
export const listLinearTeamsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/task-sources/linear/teams',
  responsesByStatusCode: { 200: linearTeamsViewSchema, ...errorResponses },
})

export const getLinearInstallUrlContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/task-sources/linear/install-url',
  responsesByStatusCode: { 200: linearInstallUrlViewSchema, ...errorResponses },
})

export const listTasksContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/tasks',
  responsesByStatusCode: { 200: taskListSchema, ...errorResponses },
})

export const importTaskContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/task-sources/${source}/import`,
  requestBodySchema: importTaskSchema,
  responsesByStatusCode: { 201: sourceTaskSchema, ...errorResponses },
})

export const searchTasksContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/task-sources/${source}/search`,
  requestBodySchema: searchTasksSchema,
  responsesByStatusCode: { 200: taskSearchResultsViewSchema, ...errorResponses },
})

export const linkTaskContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/tasks/link',
  requestBodySchema: linkTaskSchema,
  responsesByStatusCode: { 201: sourceTaskSchema, ...errorResponses },
})

export const createTaskFromIssueContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/tasks/create-block',
  requestBodySchema: createTaskFromIssueSchema,
  responsesByStatusCode: { 201: createTaskFromIssueResultSchema, ...errorResponses },
})

export const spawnEpicContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/task-sources/${source}/epics/spawn`,
  requestBodySchema: spawnEpicSchema,
  responsesByStatusCode: { 201: spawnEpicResultSchema, ...errorResponses },
})
