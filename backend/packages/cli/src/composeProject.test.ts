import { describe, expect, it } from 'vitest'
import { composeProjectNameFor, orphanedComposeProjectNote } from './composeProject.js'

const FALLBACK = 'cat-factory'

describe('composeProjectNameFor', () => {
  it('names the project after the deployment directory', () => {
    expect(composeProjectNameFor('/home/dev/deploy-a', FALLBACK)).toBe('deploy-a-local')
    expect(composeProjectNameFor('/home/dev/deploy-b', FALLBACK)).toBe('deploy-b-local')
  })

  it('never returns the directory default two deployments would share', () => {
    // `local` is what Compose derives from the compose file's own directory, which is the same
    // in every deployment: the collision this name exists to prevent.
    for (const dir of ['/home/dev/todo-list', '/srv/acme.site', '/tmp/x']) {
      expect(composeProjectNameFor(dir, FALLBACK)).not.toBe('local')
    }
  })

  it('coerces a free-text directory name into Compose charset', () => {
    expect(composeProjectNameFor('/home/dev/ Todo List ', FALLBACK)).toBe('todo-list-local')
    expect(composeProjectNameFor('/home/dev/ACME Site', FALLBACK)).toBe('acme-site-local')
    expect(composeProjectNameFor('/home/dev/.__Acme..Site__', FALLBACK)).toBe('acme__site-local')
  })

  it('keeps dotted and spaced directory names apart, mapping the dot to an underscore', () => {
    // Compose allows `_` but not `.`, so folding the dot onto a hyphen would put these two
    // deployments back in one project, sharing one Postgres volume.
    const dotted = composeProjectNameFor('/home/dev/acme.site', FALLBACK)
    const spaced = composeProjectNameFor('/home/dev/acme site', FALLBACK)
    expect(dotted).toBe('acme_site-local')
    expect(dotted).not.toBe(spaced)
  })

  it('produces a name Compose accepts from every directory shape', () => {
    for (const dir of [
      '/home/dev/deploy-a',
      '/home/dev/ Todo List ',
      '/srv/acme.site',
      '/srv/.__Acme..Site__',
      '/srv/!!!',
      '/',
    ]) {
      // Docker's own rule for a project name.
      expect(composeProjectNameFor(dir, FALLBACK)).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
    }
  })

  it('falls back when the directory name leaves nothing usable', () => {
    expect(composeProjectNameFor('/home/dev/!!!', FALLBACK)).toBe('cat-factory-local')
    expect(composeProjectNameFor('/', FALLBACK)).toBe('cat-factory-local')
    expect(composeProjectNameFor('/home/dev/!!!', 'other')).toBe('other-local')
  })
})

describe('orphanedComposeProjectNote', () => {
  const previousGenerated = `# Local Postgres
name: todo-list-local

services:
  postgres:
    image: postgres:18
`
  const beforeNamesExisted = `# Local Postgres
services:
  postgres:
    image: postgres:18
`

  it('names the Compose directory default for a file that declares no project', () => {
    const note = orphanedComposeProjectNote(beforeNamesExisted, 'deploy-a-local')
    expect(note).toContain('"local"')
    expect(note).toContain('local_cat-factory-pg')
    expect(note).toContain('docker compose -p local down')
    expect(note).toContain('"deploy-a-local"')
  })

  it('names the project a previously generated file declared', () => {
    const note = orphanedComposeProjectNote(previousGenerated, 'deploy-a-local')
    expect(note).toContain('"todo-list-local"')
    expect(note).toContain('docker compose -p todo-list-local down')
  })

  it('reads a quoted name', () => {
    const note = orphanedComposeProjectNote(`name: "todo-list-local"\n`, 'deploy-a-local')
    expect(note).toContain('docker compose -p todo-list-local down')
  })

  it('says nothing when the project name does not move', () => {
    expect(orphanedComposeProjectNote(previousGenerated, 'todo-list-local')).toBeUndefined()
  })

  it('ignores an indented `name:` belonging to a nested key', () => {
    const nested = `services:
  postgres:
    name: not-the-project
`
    const note = orphanedComposeProjectNote(nested, 'deploy-a-local')
    expect(note).toContain('docker compose -p local down')
    expect(note).not.toContain('not-the-project')
  })
})
