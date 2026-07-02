// The sanitized environment for NATIVE-mode child processes (the host-process harness and
// the inline ambient CLIs). In a container the harness sees a clean env; spawned natively
// with `...process.env` it would inherit the ORCHESTRATOR's full environment — DATABASE_URL,
// ENCRYPTION_KEY, AUTH_SESSION_SECRET, GITHUB_PAT, provider API keys — and pass it straight
// on to a prompt-injectable agent subprocess with shell access. So native children get an
// ALLOW-LIST projection instead: what a shell tool, git, and the ambient `claude`/`codex`
// CLIs actually need (PATH/HOME/locale/temp/proxy/their own config homes), nothing else.
// The deploy-harness transport deliberately opts OUT (`envMode: 'inherit'`) — kubectl/helm
// legitimately run on ambient cloud/cluster env (KUBECONFIG, AWS_*, …).

/** Exact variable names (compared case-insensitively) a native child may inherit. */
const EXACT_ALLOW = new Set([
  // POSIX basics
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  'LANG',
  'TERM',
  // Windows process/tooling basics
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  // Outbound proxies (both cases exist in the wild; the compare is case-insensitive)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  // Ambient CLI config homes — the whole point of native mode is the developer's own login
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
])

/** Name prefixes (compared case-insensitively) a native child may inherit. */
const PREFIX_ALLOW = ['LC_', 'XDG_']

/**
 * Project `env` down to the allow-list above, plus any names the operator adds via
 * `LOCAL_HARNESS_ENV_ALLOW` (comma-separated, case-insensitive) — the escape hatch for a
 * setup whose CLI/tooling needs a variable the list doesn't know (a wrapper script, a
 * custom cert bundle, …). Original key casing is preserved.
 */
export function sanitizedChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const extra = new Set(
    (env.LOCAL_HARNESS_ENV_ALLOW ?? '')
      .split(',')
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean),
  )
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (
      EXACT_ALLOW.has(upper) ||
      PREFIX_ALLOW.some((prefix) => upper.startsWith(prefix)) ||
      extra.has(upper)
    ) {
      out[key] = value
    }
  }
  return out
}
