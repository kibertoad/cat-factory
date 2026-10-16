// The board as the task-creating forms read it: the shared board with the built-in pipelines a
// feature, a bug, a document, a review and a bug-fishing task can run, the merge policies and the
// model presets. The pipelines and policies are the shared copies of the backend's seeds.
import type { WorkspaceSnapshot } from '@cat-factory/contracts'
import {
  adaptiveBuild,
  bugFishingPipeline,
  bugfixPipeline,
  documentPipeline,
  reproTestKind,
  reviewPipeline,
  standardBuild,
} from './pipelines.stories.mocks'
import { manualReviewPolicy, modelPreset, riskPolicy } from './policies.stories.mocks'
import { snapshot } from './snapshot.stories.mocks'

export function taskFormSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return snapshot({
    pipelines: [
      standardBuild,
      adaptiveBuild,
      bugfixPipeline,
      documentPipeline,
      reviewPipeline,
      bugFishingPipeline,
    ],
    customAgentKinds: [reproTestKind],
    riskPolicies: [riskPolicy(), manualReviewPolicy],
    modelPresets: [
      modelPreset(),
      modelPreset({
        id: 'mdp_claude',
        name: 'Claude Opus 5',
        baseModelId: 'claude-opus-5',
        isDefault: false,
        version: 2,
      }),
    ],
    ...overrides,
  })
}
