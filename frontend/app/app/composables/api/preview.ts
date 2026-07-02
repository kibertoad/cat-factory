import {
  getPreviewContract,
  startPreviewContract,
  stopPreviewContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Browsable frontend preview: start / poll / stop a served preview for a `frontend` frame. */
export function previewApi({ send, ws }: ApiContext) {
  return {
    getPreview: (workspaceId: string, frameId: string) =>
      send(getPreviewContract, { pathPrefix: ws(workspaceId), pathParams: { frameId } }),

    startPreview: (workspaceId: string, frameId: string) =>
      send(startPreviewContract, { pathPrefix: ws(workspaceId), pathParams: { frameId } }),

    stopPreview: (workspaceId: string, frameId: string) =>
      send(stopPreviewContract, { pathPrefix: ws(workspaceId), pathParams: { frameId } }),
  }
}
