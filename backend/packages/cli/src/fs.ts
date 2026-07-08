import * as nodeFs from 'node:fs'

/** The filesystem operations the writers need — injectable so the flows are testable. */
export interface FileSystem {
  existsSync(path: string): boolean
  mkdirSync(path: string, options: { recursive: true }): void
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
}

/** The real, `node:fs`-backed {@link FileSystem}. */
export const realFs: FileSystem = {
  existsSync: (p) => nodeFs.existsSync(p),
  mkdirSync: (p, o) => {
    nodeFs.mkdirSync(p, o)
  },
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  writeFileSync: (p, d) => {
    nodeFs.writeFileSync(p, d)
  },
}
