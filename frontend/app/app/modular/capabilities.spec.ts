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
