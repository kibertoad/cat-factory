import { stat } from 'node:fs/promises'

/** Whether `path` exists (a file or directory), swallowing ENOENT (and any stat error). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
