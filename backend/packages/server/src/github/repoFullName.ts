/** Split an `owner/name` full name into its parts (an unslashed value is treated as the name). */
export function splitRepo(full: string): [string, string] {
  const i = full.indexOf('/')
  return i === -1 ? ['', full] : [full.slice(0, i), full.slice(i + 1)]
}
