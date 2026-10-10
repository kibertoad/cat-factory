// `pnpm --filter @cat-factory/acceptance run configure`: assemble the suite's `.env` by asking.
//
// A sibling of `statusCli.ts` and thin for the same reason: everything worth reading lives in
// `configure.ts` (the flow) and `configureEnv.ts` (the write), both driven by seams so
// `test/configure.test.ts` can run the whole thing with no deployment, no cluster and no terminal.
// This file only supplies the real ones.
//
// Unlike `status`, this DOES talk to the deployment: it resolves the workspace, the connected
// account, the repository list and the preset library rather than asking for them. It creates
// nothing there, and it writes exactly one file.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createConsoleIo, createNodeShell } from '@cat-factory/cli'
import { configure, connectDeployment } from './configure.ts'
import { packageRoot } from './packageRoot.ts'

const outcome = await configure({
  io: createConsoleIo(),
  shell: createNodeShell(),
  // At the package root, which is where every command that needs it looks (`envFile.ts`): nothing
  // applies a `.env` for a Node entry point on its own.
  envPath: join(packageRoot, '.env'),
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // silent-catch-ok: no `.env` yet is the normal first-run state, which is this command's whole
      // reason to exist, and it is reported as "no file yet" rather than as a failure.
      return null
    }
  },
  writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
  connect: connectDeployment,
})

if (!outcome.ok) process.exit(1)
