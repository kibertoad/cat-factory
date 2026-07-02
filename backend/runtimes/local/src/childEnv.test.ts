import { describe, expect, it } from 'vitest'
import { sanitizedChildEnv } from './childEnv.js'

// The allow-list projection for native-mode children: the orchestrator's secrets must never
// reach a host process that spawns an agent with shell access.

describe('sanitizedChildEnv', () => {
  it('keeps the allow-listed basics and drops everything else', () => {
    const out = sanitizedChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/home/dev/.config',
      HTTPS_PROXY: 'http://proxy:3128',
      CLAUDE_CONFIG_DIR: '/home/dev/.claude',
      CODEX_HOME: '/home/dev/.codex',
      // orchestrator secrets that must NOT pass
      DATABASE_URL: 'postgres://secret',
      ENCRYPTION_KEY: 'k3y',
      AUTH_SESSION_SECRET: 's3ss',
      GITHUB_PAT: 'ghp_x',
      ANTHROPIC_API_KEY: 'sk-ant-x',
    })
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/home/dev/.config',
      HTTPS_PROXY: 'http://proxy:3128',
      CLAUDE_CONFIG_DIR: '/home/dev/.claude',
      CODEX_HOME: '/home/dev/.codex',
    })
  })

  it('matches names case-insensitively but preserves the original casing', () => {
    // Windows env names vary in case (Path, ComSpec); lowercase proxy vars are common on *nix.
    const out = sanitizedChildEnv({
      Path: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      http_proxy: 'http://proxy:3128',
      database_url: 'postgres://secret',
    })
    expect(out).toEqual({
      Path: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      http_proxy: 'http://proxy:3128',
    })
  })

  it('passes extra names through the LOCAL_HARNESS_ENV_ALLOW escape hatch', () => {
    const out = sanitizedChildEnv({
      LOCAL_HARNESS_ENV_ALLOW: 'NODE_EXTRA_CA_CERTS, my_wrapper_flag',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      MY_WRAPPER_FLAG: 'on',
      DATABASE_URL: 'postgres://secret',
    })
    expect(out.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp.pem')
    expect(out.MY_WRAPPER_FLAG).toBe('on')
    expect(out.DATABASE_URL).toBeUndefined()
    // The allow-list itself is not an allow-listed variable.
    expect(out.LOCAL_HARNESS_ENV_ALLOW).toBeUndefined()
  })

  it('skips undefined values', () => {
    expect(sanitizedChildEnv({ PATH: undefined })).toEqual({})
  })
})
