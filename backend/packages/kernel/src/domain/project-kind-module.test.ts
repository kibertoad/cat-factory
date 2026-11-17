import { describe, expect, it } from 'vitest'
import {
  ProjectKindModuleRegistry,
  eraseTaskHandler,
  outcomesOf,
  type DecodedProjectOutcome,
  type ProjectKindModule,
  type ProjectTaskHandler,
} from './project-kind-module.js'

function handler(taskType: string, agentKind: string): ProjectTaskHandler<{ note: string }> {
  return {
    taskType,
    agentKind,
    outcomeSchemaVersion: 1,
    parseOutcome: (_v, value) => value as { note: string },
    planTask: () => ({ intent: 'write', stream: 'main', plan: {} }),
    brief: () => ({}),
    mergeCheckpoint: (_a, b) => b,
    finish: ({ reply }) => ({ body: reply, output: reply.note }),
    describe: ({ body }) => body.note,
    artifactRefs: () => [],
  }
}

function module(kind: string, handlers: ProjectTaskHandler<{ note: string }>[]): ProjectKindModule {
  return {
    kind,
    handlers: handlers.map(eraseTaskHandler),
    parseSpec: () => ({ ok: true, value: {} }),
    definitionSummary: (d) => d.title,
  }
}

describe('ProjectKindModuleRegistry', () => {
  it('lets two kinds offer the same handler and finds it by task type and agent kind', () => {
    const shared = handler('notes', 'note-taker')
    const registry = new ProjectKindModuleRegistry()
    registry.register(module('alpha', [shared]))
    registry.register(module('beta', [shared, handler('memo', 'memo-writer')]))
    expect(registry.handler('notes')).toBe(shared)
    expect(registry.forAgentKind('memo-writer')?.taskType).toBe('memo')
    expect(registry.handlerOf('alpha', 'notes')).toBe(shared)
    expect(registry.handlerOf('alpha', 'memo')).toBeUndefined()
  })

  it('refuses a second, different handler for one task type', () => {
    const registry = new ProjectKindModuleRegistry()
    registry.register(module('alpha', [handler('notes', 'note-taker')]))
    expect(() => registry.register(module('beta', [handler('notes', 'other-taker')]))).toThrow(
      /two different handlers are registered for task type 'notes'/,
    )
    expect(registry.get('beta')).toBeUndefined()
  })

  it('refuses two task types sharing one agent kind', () => {
    const registry = new ProjectKindModuleRegistry()
    registry.register(module('alpha', [handler('notes', 'writer')]))
    expect(() => registry.register(module('beta', [handler('memo', 'writer')]))).toThrow(
      /cannot share the agent kind 'writer'/,
    )
  })

  it('refuses a module that names no handler, and a second module for one kind', () => {
    const registry = new ProjectKindModuleRegistry()
    expect(() => registry.register(module('alpha', []))).toThrow(/names no task handler/)
    registry.register(module('alpha', [handler('notes', 'note-taker')]))
    expect(() => registry.register(module('alpha', [handler('notes', 'note-taker')]))).toThrow(
      /already registered/,
    )
  })
})

describe('outcomesOf', () => {
  it("keeps only the outcomes of the handler's own task type, in order", () => {
    const outcome = (id: string, taskType: string | null): DecodedProjectOutcome => ({
      id,
      projectId: 'p1',
      stream: 'main',
      seq: 1,
      intent: 'write',
      schemaVersion: 1,
      taskId: null,
      taskType,
      definitionKey: null,
      definitionVersion: null,
      artifactRefs: [],
      createdAt: 1,
      body: { note: id },
    })
    const all = [
      outcome('a', 'notes'),
      outcome('b', 'memo'),
      outcome('c', null),
      outcome('d', 'notes'),
    ]
    expect(outcomesOf(handler('notes', 'x'), all).map((o) => o.id)).toEqual(['a', 'd'])
  })
})
