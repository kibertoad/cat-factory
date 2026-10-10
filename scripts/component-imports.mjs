// Detection for `check-component-imports.mjs`: which PascalCase tags in a Vue SFC template
// reference a layer component that the file never imported.
//
// Split out from the walker for the same reason `silent-catch.mjs` is: the guard is the only
// thing standing between this bug class and a silent recurrence, so its logic gets fixtures
// (`component-imports.test.mjs`) rather than being trusted on sight.

/**
 * Vue's own built-in / special elements. A layer component sharing one of these names would be a
 * naming mistake of its own, but the guard must not be the thing that reports it.
 */
const VUE_BUILTINS = new Set([
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Teleport',
  'Suspense',
  'Component',
  'Fragment',
  'Slot',
])

/**
 * The SFC's top-level template, or `''` when the file has none (a render-function component).
 *
 * Deliberately spans the FIRST `<template` to the LAST `</template>`: inner `<template v-if>`
 * wrappers are common, and anything between the outer pair is markup either way. A `<script>`
 * block must stay out of range, which this gives, since Vue requires the blocks to be siblings.
 */
export function templateBlock(source) {
  const start = source.indexOf('<template')
  if (start === -1) return ''
  const end = source.lastIndexOf('</template>')
  if (end === -1 || end < start) return ''
  return source.slice(start, end)
}

/**
 * PascalCase tag names opened anywhere in `markup`.
 *
 * Only an opening tag counts, so a closing `</Foo>` is not double-reported. The trailing class
 * requires the name to END, or `<StepTestReport` would also be read as a use of `<StepTest`.
 */
export function usedComponentTags(markup) {
  const tags = new Set()
  for (const match of markup.matchAll(/<([A-Z][A-Za-z0-9]*)(?=[\s/>])/g)) {
    if (!VUE_BUILTINS.has(match[1])) tags.add(match[1])
  }
  return tags
}

/**
 * Whether `name` is bound in the SFC's script by an import, either default (`import Foo from`)
 * or named (`import { Foo }`, `import { x, Foo as Bar }`).
 *
 * A local `const Foo = defineAsyncComponent(...)` / `= resolveComponent(...)` binding counts too:
 * both are legitimate ways to make a component resolvable, and neither leans on auto-registration.
 */
export function bindsComponent(source, name) {
  const n = escapeForRegex(name)
  return (
    new RegExp(`import\\s+${n}\\s*(,|from)`).test(source) ||
    new RegExp(`import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`, 's').test(source) ||
    new RegExp(`\\b(const|let|var)\\s+${n}\\s*=`).test(source)
  )
}

function escapeForRegex(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split an identifier on case transitions and on `-`, `_`, `/`, `.` — a port of scule's
 * `splitByCase`, which is what Nuxt itself uses to derive a component name.
 *
 * Ported rather than imported because the guard must run before `pnpm install` in the
 * `repo-guards` CI job, and scule is only a transitive dependency of nuxt.
 */
export function splitByCase(value) {
  const SPLITTERS = new Set(['-', '_', '/', '.'])
  const parts = []
  let buff = ''
  let previousUpper = null
  let previousSplitter = null
  for (const char of value) {
    if (SPLITTERS.has(char)) {
      parts.push(buff)
      buff = ''
      previousUpper = null
      previousSplitter = true
      continue
    }
    const isUpper = char.toUpperCase() === char
    if (previousSplitter === false) {
      // Rising edge: `fooBar` -> `foo` | `Bar`
      if (previousUpper === false && isUpper === true) {
        parts.push(buff)
        buff = char
        previousUpper = isUpper
        continue
      }
      // Falling edge: `FOOBar` -> `FOO` | `Bar`
      if (previousUpper === true && isUpper === false && buff.length > 1) {
        const lastChar = buff.at(-1)
        parts.push(buff.slice(0, Math.max(0, buff.length - 1)))
        buff = lastChar + char
        previousUpper = isUpper
        continue
      }
    }
    buff += char
    previousUpper = isUpper
    previousSplitter = false
  }
  parts.push(buff)
  return parts.filter(Boolean)
}

/**
 * The name Nuxt registers a component under, given its path relative to the `components/` dir.
 *
 * The subtlety this exists for is DEDUPLICATION: a directory segment the filename already repeats
 * is dropped, so `pipeline/PipelinePicker.vue` is `PipelinePicker` (not `PipelinePipelinePicker`)
 * while `pipeline/AgentKindIcon.vue` is `PipelineAgentKindIcon`. That is the whole reason some bare
 * tags in this codebase work and others silently do not, so the guard cannot skip it. Mirrors
 * `resolveComponentNameSegments` in `@nuxt/kit`.
 *
 * Note what this means for the working cases: they resolve only because a folder name happens to
 * lead the filename. Rename either and the tag breaks with no error, which is why the README asks
 * for an explicit import regardless.
 */
export function registeredComponentName(relPath) {
  const withoutExt = relPath.replace(/\.vue$/, '')
  const segments = withoutExt.split('/')
  const fileName = segments.pop()
  const prefixParts = segments.flatMap((segment) => splitByCase(segment))
  const fileNameParts = splitByCase(fileName)
  const fileNameContent = fileNameParts.join('/').toLowerCase()

  const nameParts = [...prefixParts]
  const matchedSuffix = []
  for (let index = prefixParts.length - 1; index >= 0; index--) {
    matchedSuffix.unshift(prefixParts[index].toLowerCase())
    const suffixContent = matchedSuffix.join('/')
    if (fileNameContent === suffixContent || fileNameContent.startsWith(`${suffixContent}/`)) {
      nameParts.length = index
      break
    }
  }
  return [...nameParts, ...fileNameParts].map(pascal).join('')
}

function pascal(part) {
  return part.charAt(0).toUpperCase() + part.slice(1)
}

/**
 * The unresolved layer-component tags in one SFC.
 *
 * `layerComponents` maps a component basename to the set of paths defining it; `bareRegistered`
 * holds the basenames Nuxt DOES register under their bare name, per
 * {@link registeredComponentName}.
 */
export function findUnresolvedComponents(source, { layerComponents, bareRegistered }) {
  const unresolved = []
  for (const tag of usedComponentTags(templateBlock(source))) {
    if (!layerComponents.has(tag)) continue // not one of ours; Nuxt UI, a package, an HTML custom element
    if (bareRegistered.has(tag)) continue // registered under this exact name, so the tag resolves
    if (bindsComponent(source, tag)) continue
    unresolved.push({ tag, definedAt: [...layerComponents.get(tag)].sort() })
  }
  return unresolved.sort((a, b) => a.tag.localeCompare(b.tag))
}
