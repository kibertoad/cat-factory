import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceCapabilitiesManifest,
  WORKSPACE_CAPABILITIES_MANIFEST_ID,
  workspaceCapabilitiesVersion,
} from './capabilities'
import type { AgentKind, CustomAgentKind, CustomTaskType } from '~/types/domain'

const kind = (
  over: Partial<CustomAgentKind['presentation']> = {},
  kindId = 'acme-audit',
): CustomAgentKind => ({
  kind: kindId as AgentKind,
  container: true,
  presentation: {
    label: 'Audit',
    icon: 'i-lucide-shield',
    color: '#fff',
    description: 'd',
    ...over,
  },
})

const taskType = (
  over: Partial<CustomTaskType['presentation']> = {},
  id = 'acme:incident',
): CustomTaskType => ({
  taskType: id,
  presentation: {
    label: 'Incident',
    icon: 'i-lucide-siren',
    color: '#ef4444',
    description: 'd',
    ...over,
  },
})

describe('buildWorkspaceCapabilitiesManifest', () => {
  it('models the snapshot capabilities as one manifest carrying BOTH slots', () => {
    const kinds = [kind()]
    const taskTypes = [taskType()]
    const manifest = buildWorkspaceCapabilitiesManifest(kinds, taskTypes)
    expect(manifest.id).toBe(WORKSPACE_CAPABILITIES_MANIFEST_ID)
    expect(manifest.slots?.agentKinds).toEqual(kinds)
    expect(manifest.slots?.taskTypes).toEqual(taskTypes)
  })

  it('copies the inputs (no aliasing of the caller arrays)', () => {
    const kinds = [kind()]
    const taskTypes = [taskType()]
    const manifest = buildWorkspaceCapabilitiesManifest(kinds, taskTypes)
    kinds.push(kind())
    taskTypes.push(taskType())
    expect(manifest.slots?.agentKinds).toHaveLength(1)
    expect(manifest.slots?.taskTypes).toHaveLength(1)
  })

  it('derives an identical version for identical content (so an unchanged re-hydrate no-ops)', () => {
    expect(buildWorkspaceCapabilitiesManifest([kind()], [taskType()]).version).toBe(
      buildWorkspaceCapabilitiesManifest([kind()], [taskType()]).version,
    )
  })

  it('changes the version when an agent-kind display/pairing field or the kind set differs', () => {
    const base = workspaceCapabilitiesVersion([kind()], [])
    expect(workspaceCapabilitiesVersion([kind({ label: 'Renamed' })], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([kind({ resultView: 'acme:audit' })], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([kind({}, 'acme-other')], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([kind(), kind({}, 'acme-two')], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([], [])).not.toBe(base)
  })

  it('changes the version for EVERY declared field, including the ones nothing renders', () => {
    // The signature covers the whole entry rather than a list of fields somebody kept in step,
    // because an omitted one is not a cosmetic miss: `hydrateCapabilities` no-ops on an unchanged
    // version, so an open tab keeps filtering its palette on the declaration the backend just
    // replaced. Asserted field by field over the ones that steer the builder rather than the
    // label, which is the class the old field list kept missing.
    const base = workspaceCapabilitiesVersion([kind()], [])
    expect(workspaceCapabilitiesVersion([kind({ purposes: ['review'] })], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([kind({ category: 'docs' })], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([kind({ tier: 'basic' })], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([{ ...kind(), container: false }], [])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([{ ...kind(), binaryOutput: true }], [])).not.toBe(base)
    expect(
      workspaceCapabilitiesVersion([{ ...kind(), companionTargets: ['coder' as AgentKind] }], []),
    ).not.toBe(base)
    // And a purposes list is ORDER-bearing content, not a set: two spellings of the same
    // declaration are two declarations, so re-signing is the honest answer over guessing.
    expect(workspaceCapabilitiesVersion([kind({ purposes: ['review', 'build'] })], [])).not.toBe(
      workspaceCapabilitiesVersion([kind({ purposes: ['build', 'review'] })], []),
    )
  })

  it('ignores the KEY ORDER a snapshot happened to serialize with', () => {
    // The whole point of canonicalizing rather than hashing the raw JSON: a re-serialization
    // that reorders keys is the same catalog, and re-swapping the manifest for it would
    // invalidate every `agentKindMeta` consumer for nothing.
    const ordered: CustomAgentKind = {
      kind: 'acme-audit' as AgentKind,
      container: true,
      presentation: { label: 'Audit', icon: 'i-lucide-shield', color: '#fff', description: 'd' },
    }
    const reordered: CustomAgentKind = {
      presentation: { description: 'd', color: '#fff', icon: 'i-lucide-shield', label: 'Audit' },
      container: true,
      kind: 'acme-audit' as AgentKind,
    }
    expect(workspaceCapabilitiesVersion([reordered], [])).toBe(
      workspaceCapabilitiesVersion([ordered], []),
    )
  })

  it('reads an explicitly-undefined field as an absent one', () => {
    // A projection that spreads a conditional field (`...(x ? { x } : {})`) and one that assigns
    // `x: undefined` describe the same catalog, so they must not hash differently.
    expect(workspaceCapabilitiesVersion([{ ...kind(), binaryOutput: undefined }], [])).toBe(
      workspaceCapabilitiesVersion([kind()], []),
    )
  })

  it('changes the version when a task-type field, its fields, or the set differs', () => {
    const base = workspaceCapabilitiesVersion([], [taskType()])
    expect(workspaceCapabilitiesVersion([], [taskType({ label: 'Renamed' })])).not.toBe(base)
    expect(workspaceCapabilitiesVersion([], [taskType({}, 'acme:other')])).not.toBe(base)
    expect(
      workspaceCapabilitiesVersion([], [{ ...taskType(), defaultPipelineId: 'pl_review' }]),
    ).not.toBe(base)
    expect(
      workspaceCapabilitiesVersion(
        [],
        [{ ...taskType(), fields: [{ key: 'sev', label: 'Severity', type: 'text' }] }],
      ),
    ).not.toBe(base)
    expect(workspaceCapabilitiesVersion([], [])).not.toBe(base)
  })
})
