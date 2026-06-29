import { randomBytes } from 'node:crypto'

// Print the two mandatory local-mode crypto secrets in the exact formats the loader expects,
// ready to paste into deploy/local/.env. Cross-platform (pure Node — no `openssl`, which isn't
// guaranteed on Windows). Run once: AUTH_SESSION_SECRET signs the session JWT and ENCRYPTION_KEY
// seals credentials at rest, so they must stay STABLE — regenerating them forces a re-login and
// orphans any encrypted credentials. Keep the values you generate here.
const lines = [
  `AUTH_SESSION_SECRET=${randomBytes(32).toString('hex')}`,
  `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
]

process.stdout.write(`${lines.join('\n')}\n`)
