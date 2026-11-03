import type { ApiContext } from './context'

/** One image attached to a task, as its listing returns it (metadata only). */
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
 *
 * Every call names the TASK, never a bare artifact id: the images live at the workspace that homes
 * the task, which for a mounted shared service is not the board in the URL, and the server
 * resolves that home from the task.
 */
export function taskImagesApi({ ws, http }: ApiContext) {
  const images = (workspaceId: string, blockId: string) =>
    `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/images`
  return {
    listTaskImages: (workspaceId: string, blockId: string) =>
      http<{ artifacts: TaskImageRecord[] }>(images(workspaceId, blockId), { method: 'GET' }),

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

    /** The bytes as an object URL, with the media type the server served them as. */
    fetchTaskImageBlob: async (
      workspaceId: string,
      blockId: string,
      artifactId: string,
    ): Promise<{ url: string; contentType: string }> => {
      const blob: Blob = await http(
        `${images(workspaceId, blockId)}/${encodeURIComponent(artifactId)}/blob`,
        { method: 'GET', responseType: 'blob' },
      )
      return { url: URL.createObjectURL(blob), contentType: blob.type }
    },

    deleteTaskImage: (workspaceId: string, blockId: string, artifactId: string) =>
      http(`${images(workspaceId, blockId)}/${encodeURIComponent(artifactId)}`, {
        method: 'DELETE',
      }),
  }
}
