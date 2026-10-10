import { randomBytes } from 'node:crypto'

// Print the three mandatory local-mode secrets in the exact formats the loader expects, ready to
// paste into deploy/local/.env. Cross-platform (pure Node — no `openssl`, which isn't guaranteed
// on Windows). Run once: AUTH_SESSION_SECRET signs the session JWT, ENCRYPTION_KEY seals
// credentials at rest, and HARNESS_SHARED_SECRET authenticates calls to agent containers — so all
// three must stay STABLE. Regenerating them forces a re-login, orphans encrypted credentials, or
// breaks re-attach to in-flight run containers after a restart. Keep the values you generate here.
const lines = [
  `AUTH_SESSION_SECRET=${randomBytes(32).toString('hex')}`,
  `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
  `HARNESS_SHARED_SECRET=${randomBytes(32).toString('hex')}`,
]

process.stdout.write(`${lines.join('\n')}\n`)
