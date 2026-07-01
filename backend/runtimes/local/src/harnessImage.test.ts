import { describe, expect, it } from 'vitest'
import {
  type ImageExec,
  isMutableImageTag,
  looksRemoteImageRef,
  RECOMMENDED_HARNESS_IMAGE,
  refreshHarnessImage,
  resolveHarnessImage,
  resolveRefreshMode,
} from './harnessImage.js'

describe('resolveHarnessImage', () => {
  it('defaults to the backend-matched pin when unset/blank', () => {
    expect(resolveHarnessImage({})).toBe(RECOMMENDED_HARNESS_IMAGE)
    expect(resolveHarnessImage({ LOCAL_HARNESS_IMAGE: '   ' })).toBe(RECOMMENDED_HARNESS_IMAGE)
  })

  it('lets an explicit value win (trimmed)', () => {
    expect(resolveHarnessImage({ LOCAL_HARNESS_IMAGE: '  my/image:1  ' })).toBe('my/image:1')
  })
})

describe('resolveRefreshMode', () => {
  it('defaults to pull when unset or blank', () => {
    expect(resolveRefreshMode({})).toBe('pull')
    expect(resolveRefreshMode({ LOCAL_HARNESS_IMAGE_REFRESH: '  ' })).toBe('pull')
  })

  it('treats every off-style value (not just the literal "off") as disabled', () => {
    for (const off of ['false', '0', 'off', 'no', 'none', 'disabled', 'OFF', ' Off ']) {
      expect(resolveRefreshMode({ LOCAL_HARNESS_IMAGE_REFRESH: off })).toBe('off')
    }
  })

  it('pulls for an unrecognised value', () => {
    expect(resolveRefreshMode({ LOCAL_HARNESS_IMAGE_REFRESH: 'yes' })).toBe('pull')
  })
})

describe('looksRemoteImageRef', () => {
  it('is true for registry refs and false for bare local tags', () => {
    expect(looksRemoteImageRef('ghcr.io/kibertoad/cat-factory-executor:1.27.4')).toBe(true)
    expect(looksRemoteImageRef('ghcr.io/kibertoad/cat-factory-executor')).toBe(true) // implicit tag
    expect(looksRemoteImageRef('cat-factory-executor:local')).toBe(false)
    expect(looksRemoteImageRef('cat-factory-executor')).toBe(false)
  })
})

describe('isMutableImageTag', () => {
  it('flags latest/main/edge and implicit tags, not pins or digests', () => {
    expect(isMutableImageTag('ghcr.io/x/y:latest')).toBe(true)
    expect(isMutableImageTag('ghcr.io/x/y')).toBe(true) // implicit :latest
    expect(isMutableImageTag('ghcr.io/x/y:main')).toBe(true)
    expect(isMutableImageTag('ghcr.io/x/y:1.27.4')).toBe(false)
    expect(isMutableImageTag('cat-factory-executor:local')).toBe(false)
    expect(isMutableImageTag('ghcr.io/x/y@sha256:abc')).toBe(false)
  })
})

/** Scriptable container-CLI stub: pull outcome, presence, and before/after repo digests. */
function fakeExec(opts: {
  pullStatus?: number
  exists?: boolean
  digestBefore?: string
  digestAfter?: string
}): { exec: ImageExec; calls: string[][] } {
  const calls: string[][] = []
  let pulled = false
  const exec: ImageExec = async (args) => {
    calls.push(args)
    if (args[0] === 'pull') {
      pulled = true
      return { status: opts.pullStatus ?? 0, stdout: '' }
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const fmt = args[3] ?? ''
      if (fmt === '{{.Id}}') {
        return {
          status: opts.exists === false ? 1 : 0,
          stdout: opts.exists === false ? '' : 'sha256:id',
        }
      }
      const digest = (pulled ? opts.digestAfter : opts.digestBefore) ?? ''
      return { status: digest ? 0 : 1, stdout: digest }
    }
    return { status: 1, stdout: '' }
  }
  return { exec, calls }
}

function fakeLog(): {
  log: { info: (m: string) => void; warn: (m: string) => void }
  info: string[]
  warn: string[]
} {
  const info: string[] = []
  const warn: string[] = []
  return { log: { info: (m) => info.push(m), warn: (m) => warn.push(m) }, info, warn }
}

const REMOTE = RECOMMENDED_HARNESS_IMAGE
const pulled = (calls: string[][]) => calls.some((c) => c[0] === 'pull')

describe('refreshHarnessImage', () => {
  it('pulls a registry ref and reports up-to-date when the digest is unchanged', async () => {
    const { exec, calls } = fakeExec({ digestBefore: 'sha256:a', digestAfter: 'sha256:a' })
    const { log, info } = fakeLog()
    await refreshHarnessImage({
      image: REMOTE,
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(pulled(calls)).toBe(true)
    expect(info.some((m) => m.includes('up to date'))).toBe(true)
  })

  it('reports an update when the digest changes', async () => {
    const { exec } = fakeExec({ digestBefore: 'sha256:a', digestAfter: 'sha256:b' })
    const { log, info } = fakeLog()
    await refreshHarnessImage({
      image: REMOTE,
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(
      info.some((m) => m.includes('updated') && m.includes('sha256:a') && m.includes('sha256:b')),
    ).toBe(true)
  })

  it('reports a first-time pull (image absent before) as pulled, not up to date', async () => {
    const { exec } = fakeExec({ digestAfter: 'sha256:new' })
    const { log, info } = fakeLog()
    await refreshHarnessImage({
      image: REMOTE,
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(info.some((m) => m.includes('pulled') && m.includes('sha256:new'))).toBe(true)
    expect(info.some((m) => m.includes('up to date'))).toBe(false)
  })

  it('falls back to the local copy when the pull fails but the image is present', async () => {
    const { exec } = fakeExec({ pullStatus: 1, exists: true })
    const { log, warn } = fakeLog()
    await refreshHarnessImage({
      image: REMOTE,
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(warn.some((m) => m.includes('could not refresh'))).toBe(true)
  })

  it('warns loudly when the pull fails and nothing is present', async () => {
    const { exec } = fakeExec({ pullStatus: 1, exists: false })
    const { log, warn } = fakeLog()
    await refreshHarnessImage({
      image: REMOTE,
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(warn.some((m) => m.includes('unavailable locally'))).toBe(true)
  })

  it('does not pull when disabled', async () => {
    const { exec, calls } = fakeExec({})
    const { log, info } = fakeLog()
    await refreshHarnessImage({
      image: REMOTE,
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'off',
      exec,
      log,
    })
    expect(pulled(calls)).toBe(false)
    expect(info.some((m) => m.includes('auto-refresh disabled'))).toBe(true)
  })

  it('skips pulling on the apple runtime (its CLI verbs differ)', async () => {
    const { exec, calls } = fakeExec({})
    const { log, info } = fakeLog()
    await refreshHarnessImage({
      image: REMOTE,
      recommended: REMOTE,
      binary: 'container',
      runtimeId: 'apple',
      mode: 'pull',
      exec,
      log,
    })
    expect(pulled(calls)).toBe(false)
    expect(info.some((m) => m.includes("'apple'"))).toBe(true)
  })

  it('presence-checks (never pulls) a bare local tag', async () => {
    const { exec, calls } = fakeExec({ exists: true })
    const { log, info } = fakeLog()
    await refreshHarnessImage({
      image: 'cat-factory-executor:local',
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(pulled(calls)).toBe(false)
    expect(info.some((m) => m.includes('using local harness image'))).toBe(true)
  })

  it('warns when a bare local tag is missing', async () => {
    const { exec } = fakeExec({ exists: false })
    const { log, warn } = fakeLog()
    await refreshHarnessImage({
      image: 'cat-factory-executor:local',
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(warn.some((m) => m.includes('not found locally'))).toBe(true)
  })

  it('advises against a custom image and flags a mutable override tag', async () => {
    const custom = 'ghcr.io/kibertoad/cat-factory-executor:latest'
    const { exec } = fakeExec({ digestBefore: 'sha256:a', digestAfter: 'sha256:a' })
    const { log, info, warn } = fakeLog()
    await refreshHarnessImage({
      image: custom,
      recommended: REMOTE,
      binary: 'docker',
      runtimeId: 'docker',
      mode: 'pull',
      exec,
      log,
    })
    expect(warn.some((m) => m.includes('custom harness image') && m.includes(REMOTE))).toBe(true)
    expect(info.some((m) => m.includes('mutable tag'))).toBe(true)
  })
})
