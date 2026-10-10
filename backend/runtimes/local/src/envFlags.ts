// The local facade has several default-ON behaviours toggled off by an env flag
// (`LOCAL_NATIVE_AGENTS`, `LOCAL_HARNESS_IMAGE_REFRESH`, `LOCAL_WEB_SEARCH`). They all share
// the SAME off-value vocabulary — extracted here so the three call sites can't drift (adding
// a new off-token, e.g. `n`, is then a one-line change in one place).

/** Values that explicitly DISABLE a default-on local flag (case-insensitive, trimmed first). */
export const OFF_VALUES: ReadonlySet<string> = new Set([
  'false',
  '0',
  'off',
  'no',
  'none',
  'disabled',
])

/** True when a raw env value is an explicit off-value. Unset/blank ⇒ false (not an off-value). */
export function isOffValue(raw: string | undefined): boolean {
  return OFF_VALUES.has((raw ?? '').trim().toLowerCase())
}
