import { isDesignSource, type DocumentSourceKind } from '@cat-factory/contracts'

/**
 * The label key of a per-connection source command in the palette.
 *
 * One provider can be a document source AND a task source (Linear is both), and the two are
 * separate connections that carry the same display name. A label without the kind would list two
 * identical entries that open different dialogs, so every source command names its kind. A design
 * source (Figma, Zeplin) is a document source to the backend, but it holds designs, so it gets its
 * own word. The task word is "tracker", not a built-in's own vocabulary, because a deployment can
 * register a task source this build does not ship.
 */
export type SourceKind = 'document' | 'design' | 'task'

export const SOURCE_COMMAND_KEYS = {
  document: {
    connect: 'layout.commandBar.cmd.documentSourceConnect',
    manage: 'layout.commandBar.cmd.documentSourceManage',
  },
  design: {
    connect: 'layout.commandBar.cmd.designSourceConnect',
    manage: 'layout.commandBar.cmd.designSourceManage',
  },
  task: {
    connect: 'layout.commandBar.cmd.taskSourceConnect',
    manage: 'layout.commandBar.cmd.taskSourceManage',
  },
} as const satisfies Record<SourceKind, Record<'connect' | 'manage', string>>

export type SourceCommandKey = (typeof SOURCE_COMMAND_KEYS)[SourceKind]['connect' | 'manage']

/** The kind a document source is labelled as: its designs, or its documents. */
export function documentSourceKind(source: DocumentSourceKind): 'document' | 'design' {
  return isDesignSource(source) ? 'design' : 'document'
}

export function sourceCommandLabelKey(kind: SourceKind, connected: boolean): SourceCommandKey {
  return SOURCE_COMMAND_KEYS[kind][connected ? 'manage' : 'connect']
}
