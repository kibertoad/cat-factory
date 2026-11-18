/**
 * Model-authored JSON inside a fence one backtick longer than its longest backtick run, so a code
 * fence quoted in a value cannot close the block and spill into the prompt.
 */
export function fencedJson(value: unknown): string[] {
  const json = JSON.stringify(value, null, 2)
  const longest = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`${fence}json`, json, fence]
}
