import type { ApiContext } from './context'

/** One image attached to a task, as the block's artifact listing returns it (metadata only). */
export interface TaskImageRecord {
  id: string
  kind: string
  /** The name the image was uploaded under. */
  view: string | null
  contentType: string
  byteSize: number
  createdAt: number
}

/**
 * The images a person attaches to a task as context (`kind: context` artifacts). Raw `$fetch`
 * calls rather than contract sends, like the visual-confirmation uploads beside them: the bodies
 * are multipart and binary.
 */
export function taskImagesApi({ ws, http }: ApiContext) {
  return {
    /** The block's artifacts; the caller keeps the `context` ones. */
    listBlockArtifacts: (workspaceId: string, blockId: string) =>
      http<{ artifacts: TaskImageRecord[] }>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/artifacts`,
        { method: 'GET' },
      ),

    uploadTaskImage: (
      workspaceId: string,
      blockId: string,
      file: File,
    ): Promise<{ artifact: TaskImageRecord }> => {
      const form = new FormData()
      form.append('file', file)
      form.append('kind', 'context')
      form.append('blockId', blockId)
      form.append('view', file.name)
      return http(`${ws(workspaceId)}/artifacts`, { method: 'POST', body: form })
    },

    deleteArtifact: (workspaceId: string, artifactId: string) =>
      http(`${ws(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`, { method: 'DELETE' }),
  }
}
