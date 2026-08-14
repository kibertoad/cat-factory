// Where this package sits on disk, which is what an operator's `.env` and state directory anchor on.
//
// One module, because it was spelled out four times: once for each of the three CLIs that read an
// `.env` nothing applies for them, and once for the state directory. A layout change found in three
// of the four places leaves the fourth reading a file that is not there, which surfaces as a
// perfectly configured checkout refused with the whole missing-variable list.
//
// It is the SUITE's answer rather than the kit's: `resolveStateDir` takes a base for exactly this
// reason, since a relative `.acceptance` resolved against an installed package would land inside
// `node_modules`.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
