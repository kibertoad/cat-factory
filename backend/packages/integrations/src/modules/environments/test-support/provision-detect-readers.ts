import type { ProvisioningRepoReader } from '../provision-detect.logic.js'

// The in-memory repo readers the provisioning-detector suites are built on, shared by
// `provision-detect.logic.test.ts` (the Kubernetes half) and `provision-detect.compose.test.ts`
// (the compose / stack-recipe half) so the two files describe only their own behaviour.

// A reader that THROWS on every read (as the real GitHub/GitLab client does on a non-404 —
// auth/permission/rate-limit/transport), to prove the detectors surface an unreadable repo as a
// RepoReadError rather than a misleading "nothing found".
export function makeThrowingReader(
  message = 'GitHub GET /contents → 403: forbidden',
): ProvisioningRepoReader {
  return {
    async getFile() {
      throw new Error(message)
    },
    async listDirectory() {
      throw new Error(message)
    },
  }
}

// In-memory RepoFiles-shaped reader built from a flat path→content map. `listDirectory`
// derives the immediate children (file vs dir) from the keys, mirroring the contents API.
export function makeReader(files: Record<string, string>): ProvisioningRepoReader {
  const paths = Object.keys(files)
  return {
    async getFile(path) {
      return path in files ? { content: files[path]! } : null
    },
    async listDirectory(path) {
      const prefix = path ? `${path}/` : ''
      const children = new Map<string, 'file' | 'dir'>()
      for (const full of paths) {
        if (!full.startsWith(prefix)) continue
        const rest = full.slice(prefix.length)
        if (!rest) continue
        const slash = rest.indexOf('/')
        if (slash === -1) children.set(rest, 'file')
        else children.set(rest.slice(0, slash), 'dir')
      }
      return [...children].map(([name, type]) => ({ name, type, path: prefix + name }))
    },
  }
}

/** A minimal single-container Deployment manifest, parameterised by image reference. */
export const deployment = (image: string) => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: ${image}
`
