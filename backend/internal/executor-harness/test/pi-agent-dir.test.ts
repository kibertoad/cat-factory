import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPiAgentDir, withPiAgentDir } from '../src/pi-agent-dir.js'
import { writePiMcpConfig } from '../src/pi-mcp.js'

// Pi's config directory is per PASS: everything a job stages for Pi lands in a directory nothing
// else shares, the image's installed extensions come along, and Pi's own run state from an earlier
// job does not.

let seed: string

beforeEach(async () => {
  // The image's `~/.pi/agent` as `pi install` leaves it, plus run state an earlier job left.
  seed = await mkdtemp(join(tmpdir(), 'cf-pi-seed-'))
  await mkdir(join(seed, 'npm', 'node_modules', 'rpiv-todo'), { recursive: true })
  await writeFile(join(seed, 'settings.json'), '{"packages":["npm:rpiv-todo"]}')
  await writeFile(join(seed, 'auth.json'), '{"leaked":true}')
  await writeFile(join(seed, 'mcp.json'), '{"mcpServers":{"stale":{"command":"x"}}}')
  await mkdir(join(seed, 'sessions'))
})

afterEach(async () => {
  await rm(seed, { recursive: true, force: true })
})

describe('createPiAgentDir', () => {
  it("carries the image's installed extensions and none of Pi's run state", async () => {
    const dir = await createPiAgentDir({ seedFrom: seed })
    try {
      expect((await lstat(join(dir.path, 'npm'))).isSymbolicLink()).toBe(true)
      expect(await readdir(join(dir.path, 'npm', 'node_modules'))).toEqual(['rpiv-todo'])
      expect((await readdir(dir.path)).sort()).toEqual(['npm', 'settings.json'])
    } finally {
      await dir.dispose()
    }
  })

  it("copies the settings, so Pi's writes to them never reach the image's copy", async () => {
    const dir = await createPiAgentDir({ seedFrom: seed })
    try {
      expect((await lstat(join(dir.path, 'settings.json'))).isSymbolicLink()).toBe(false)
      await writeFile(join(dir.path, 'settings.json'), '{"changed":true}')
      expect(await readFile(join(seed, 'settings.json'), 'utf8')).toContain('rpiv-todo')
    } finally {
      await dir.dispose()
    }
  })

  it('starts empty without a seed and is owner-only', async () => {
    const dir = await createPiAgentDir()
    try {
      expect(await readdir(dir.path)).toEqual([])
      expect((await stat(dir.path)).mode & 0o077).toBe(0)
    } finally {
      await dir.dispose()
    }
  })

  it('keeps two concurrent jobs apart', async () => {
    const issues = { id: 'issues', transport: 'stdio' as const, command: 'a' }
    const docs = { id: 'docs', transport: 'http' as const, url: 'https://mcp.example.com/mcp' }
    const [first, second] = await Promise.all([
      createPiAgentDir({ seedFrom: seed }),
      createPiAgentDir({ seedFrom: seed }),
    ])
    try {
      expect(first.path).not.toBe(second.path)
      await Promise.all([
        writePiMcpConfig(first.path, [issues]),
        writePiMcpConfig(second.path, [docs]),
      ])
      const servers = async (dir: string) =>
        Object.keys(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')).mcpServers)
      expect(await servers(first.path)).toEqual(['issues'])
      expect(await servers(second.path)).toEqual(['docs'])
      // The seed's own file is untouched by either, and neither job saw it.
      expect(await readFile(join(seed, 'mcp.json'), 'utf8')).toContain('stale')
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
    }
  })
})

describe('withPiAgentDir', () => {
  it('removes the directory, and only it, when the pass throws', async () => {
    let seen: string | undefined
    await expect(
      withPiAgentDir({ seedFrom: seed }, async (dir) => {
        seen = dir
        throw new Error('pass failed')
      }),
    ).rejects.toThrow('pass failed')
    await expect(stat(seen!)).rejects.toThrow()
    // A linked directory is unlinked, never followed: the image's extensions survive.
    expect(await readdir(join(seed, 'npm', 'node_modules'))).toEqual(['rpiv-todo'])
  })
})
