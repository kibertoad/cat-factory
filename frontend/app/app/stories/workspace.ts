// The story workspace's id, in a module of its own so the pure fixtures can name it without
// importing `api.ts`, which loads msw and its browser worker.

/** The workspace every API-backed story runs in; `seedWorkspace` makes it the active one. */
export const STORY_WORKSPACE_ID = 'ws_story'

/** The `pathPrefix` the app's client puts in front of a workspace-scoped contract path. */
export const storyWorkspacePrefix = `/workspaces/${STORY_WORKSPACE_ID}`
