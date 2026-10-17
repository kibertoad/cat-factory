/**
 * The label key of a per-connection source command in the palette.
 *
 * One provider can be a document source AND a task source (Linear is both), and the two are
 * separate connections that carry the same display name. A label without the kind would list two
 * identical entries that open different dialogs, so every source command names its kind.
 */
export type SourceKind = 'document' | 'task'

export const SOURCE_COMMAND_KEYS = {
  document: {
    connect: 'layout.commandBar.cmd.documentSourceConnect',
    manage: 'layout.commandBar.cmd.documentSourceManage',
  },
  task: {
    connect: 'layout.commandBar.cmd.taskSourceConnect',
    manage: 'layout.commandBar.cmd.taskSourceManage',
  },
} as const satisfies Record<SourceKind, Record<'connect' | 'manage', string>>

export function sourceCommandLabelKey(kind: SourceKind, connected: boolean): string {
  return SOURCE_COMMAND_KEYS[kind][connected ? 'manage' : 'connect']
}
