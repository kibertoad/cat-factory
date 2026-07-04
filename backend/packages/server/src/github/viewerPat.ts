import type { Context } from 'hono'
import type { AppEnv } from '../http/env.js'

/**
 * Resolve the signed-in user's id + decrypted GitHub PAT (if they stored one), so the repo
 * picker / link can expand with — and attribute — repos only their personal token can reach.
 * Both absent (no user, or no stored PAT) ⇒ the App-only behaviour. Best-effort: a decrypt
 * failure degrades to no token rather than failing the request. Shared by the GitHub picker
 * controller and the board "add service from repo" flow so the two resolve the PAT identically.
 */
export async function resolveViewerPat<E extends AppEnv>(
  c: Context<E>,
): Promise<{ userId?: string; userToken?: string }> {
  const userId = c.get('user')?.id
  if (!userId) return {}
  const userSecrets = c.get('container').userSecrets
  if (!userSecrets) return { userId }
  try {
    const token = await userSecrets.resolve(userId, 'github_pat')
    return token ? { userId, userToken: token } : { userId }
  } catch {
    return { userId }
  }
}
