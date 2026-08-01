import { describe, expect, it } from 'vitest'
import {
  commonDirectory,
  contractIdFromPath,
  contractIdFromRelativePath,
  normalizeFilePath,
  parseServiceManifest,
  parseServiceOverview,
  slugFromDirName,
} from './foundational-source.logic.js'

describe('parseServiceManifest', () => {
  it('reads identity from frontmatter and the description from the body', () => {
    const parsed = parseServiceManifest(
      [
        '---',
        'name: File Storage',
        'summary: Stores and serves user uploads.',
        'capabilities: [file-storage, cdn]',
        '---',
        'Use this for any binary blob.',
        '',
        'Do NOT use it for structured records.',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      name: 'File Storage',
      summary: 'Stores and serves user uploads.',
      capabilities: ['file-storage', 'cdn'],
      description: 'Use this for any binary blob.\n\nDo NOT use it for structured records.',
    })
  })

  it('refuses a manifest with no name rather than inventing one from the directory', () => {
    expect(parseServiceManifest('---\nsummary: something\n---\nbody')).toBeNull()
  })

  it('falls back to the description key, then the name, for a missing summary', () => {
    expect(parseServiceManifest('---\nname: Audit\ndescription: Trail.\n---\n')?.summary).toBe(
      'Trail.',
    )
    expect(parseServiceManifest('---\nname: Audit\n---\n')?.summary).toBe('Audit')
  })
})

describe('parseServiceOverview', () => {
  it('reads the descriptive half of a manifest that names nobody', () => {
    // A `folder` source's optional root `service.md` can only enrich — the link already named
    // the service — so requiring a `name` here would silently drop its prose.
    expect(
      parseServiceOverview('---\nsummary: Trail.\ncapabilities: audit\n---\nWhat it does.'),
    ).toEqual({ summary: 'Trail.', capabilities: ['audit'], description: 'What it does.' })
  })

  it('reports an absent summary as empty rather than substituting a name it does not have', () => {
    expect(parseServiceOverview('body only')).toEqual({
      summary: '',
      capabilities: [],
      description: 'body only',
    })
  })
})

describe('slugFromDirName / contractIdFromPath', () => {
  it('lower-kebabs a directory name', () => {
    expect(slugFromDirName('File_Storage')).toBe('file-storage')
    expect(slugFromDirName('  Notifications  ')).toBe('notifications')
  })

  it('derives a contract id from the file basename without its extension', () => {
    expect(contractIdFromPath('services/file-storage/openapi.yaml')).toBe('openapi')
    expect(contractIdFromPath('api/Public_API.ts')).toBe('public-api')
  })
})

describe('contractIdFromRelativePath', () => {
  it('keeps two same-named files in different subfolders apart', () => {
    // The collision a recursive folder scan hits first, and the whole reason the basename rule
    // is not reused there: collapsing both to `users` would keep one and drop the other.
    expect(contractIdFromRelativePath('specs/v1/users.yaml', 'specs')).toBe('v1-users')
    expect(contractIdFromRelativePath('specs/v2/users.yaml', 'specs')).toBe('v2-users')
  })

  it('degrades to the basename rule for a file in the folder root', () => {
    expect(contractIdFromRelativePath('specs/openapi.yaml', 'specs')).toBe('openapi')
    expect(contractIdFromRelativePath('openapi.yaml', '')).toBe('openapi')
  })

  it('slugs the whole path when the folder is the repo root', () => {
    expect(contractIdFromRelativePath('api/v1/Public_API.ts', '')).toBe('api-v1-public-api')
  })
})

describe('commonDirectory', () => {
  it('finds the deepest shared directory of the linked files', () => {
    expect(commonDirectory(['api/v1/openapi.yaml', 'api/v1/contracts.ts'])).toBe('api/v1')
    expect(commonDirectory(['api/v1/openapi.yaml', 'api/v2/openapi.yaml'])).toBe('api')
  })

  it('falls back to the repo root when the paths share no directory', () => {
    // Correct rather than merely safe: the probe then tracks the repo head, so it can only ever
    // be too eager about a change, never miss one.
    expect(commonDirectory(['a/openapi.yaml', 'b/openapi.yaml'])).toBe('')
    expect(commonDirectory(['openapi.yaml'])).toBe('')
    expect(commonDirectory([])).toBe('')
  })
})

describe('normalizeFilePath', () => {
  it('strips a leading ./ and surrounding slashes', () => {
    expect(normalizeFilePath('./api/openapi.yaml')).toBe('api/openapi.yaml')
    expect(normalizeFilePath('/api/openapi.yaml/')).toBe('api/openapi.yaml')
  })
})
