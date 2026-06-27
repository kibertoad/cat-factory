import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  connectSlackByTokenSchema,
  slackChannelSchema,
  slackConnectionSchema,
  slackMemberMappingEntrySchema,
  slackNotificationSettingsSchema,
  updateSlackMemberMappingSchema,
  updateSlackSettingsSchema,
} from '../slack.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Workspace-scoped Slack route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. The public OAuth callback
// (`slackOAuthController`, mounted at `/slack`) returns a browser redirect and is
// not modelled as an API contract. See SlackController.
// ---------------------------------------------------------------------------

// Response wrappers that exist only inline in the controller today.
const slackConnectionViewSchema = v.object({
  connection: v.nullable(slackConnectionSchema),
  oauthEnabled: v.boolean(),
})
const slackInstallUrlSchema = v.object({ url: v.string() })
const slackChannelsViewSchema = v.object({ channels: v.array(slackChannelSchema) })
const slackMemberMappingViewSchema = v.object({
  entries: v.array(slackMemberMappingEntrySchema),
})

// ---- connection (per-account) ---------------------------------------------

export const getSlackConnectionContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/slack/connection',
  responsesByStatusCode: { 200: slackConnectionViewSchema, ...errorResponses },
})

export const getSlackInstallUrlContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/slack/install-url',
  responsesByStatusCode: { 200: slackInstallUrlSchema, ...errorResponses },
})

export const connectSlackContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/slack/connect',
  requestBodySchema: connectSlackByTokenSchema,
  responsesByStatusCode: { 201: slackConnectionSchema, ...errorResponses },
})

export const disconnectSlackContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/slack/connection',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const listSlackChannelsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/slack/channels',
  responsesByStatusCode: { 200: slackChannelsViewSchema, ...errorResponses },
})

// ---- routing (per-workspace) ----------------------------------------------

export const getSlackSettingsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/slack/settings',
  responsesByStatusCode: { 200: slackNotificationSettingsSchema, ...errorResponses },
})

export const updateSlackSettingsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/slack/settings',
  requestBodySchema: updateSlackSettingsSchema,
  responsesByStatusCode: { 200: slackNotificationSettingsSchema, ...errorResponses },
})

// ---- member mapping (per-account) -----------------------------------------

export const getSlackMemberMappingContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/slack/member-mapping',
  responsesByStatusCode: { 200: slackMemberMappingViewSchema, ...errorResponses },
})

export const updateSlackMemberMappingContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/slack/member-mapping',
  requestBodySchema: updateSlackMemberMappingSchema,
  responsesByStatusCode: { 200: slackMemberMappingViewSchema, ...errorResponses },
})
