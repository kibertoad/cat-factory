#!/usr/bin/env node
// Bans corner radii that do not follow the theme in the SPA layer (issue #2251).
//
// Nuxt UI redefines PART of Tailwind's radius scale in terms of `--ui-radius` (`.nuxt/ui.css`):
//
//     --radius-xs: calc(var(--ui-radius) * 0.5);
//     --radius-sm: var(--ui-radius);
//     --radius-md: calc(var(--ui-radius) * 1.5);
//     --radius-lg: calc(var(--ui-radius) * 2);
//     --radius-xl: calc(var(--ui-radius) * 3);
//     --radius-2xl: calc(var(--ui-radius) * 4);
//     --radius-3xl: calc(var(--ui-radius) * 6);
//
// So `rounded-xs|sm|md|lg|xl|2xl|3xl` ALREADY move with a theme document's `radius`, and a
// hand-written box on one of those steps is on the same scale as the Nuxt UI component beside it.
// Those are not the problem and are not banned. The ALLOWED set is exactly that list, which is why
// the guard checks a step against it rather than banning known-bad spellings: Tailwind also ships
// `--radius-4xl: 2rem`, which Nuxt UI does NOT rebind, so `rounded-4xl` is a 32px literal wearing a
// named step's clothes. Four shapes opt out, and the first is the one that bit:
//
//   1. BARE `rounded` and its bare side/corner aliases (`rounded-t`, `rounded-bl`). These are
//      Tailwind v3 compatibility aliases resolving through `--radius`, which v4 declares
//      `@theme default inline reference`: the value is INLINED as the literal 0.25rem and no custom
//      property survives for `--ui-radius` to override. The SPA carried 144 of them, so picking any
//      theme with a non-default radius (every preset the Nuxt UI editor ships, 0 through 0.75rem)
//      rounded the buttons and the cards and left those 144 boxes at 4px.
//   2. A step OUTSIDE the seven Nuxt UI rebinds (`rounded-4xl`). Same defect as the bare alias,
//      spelled so it reads correct.
//   3. An ARBITRARY value (`rounded-[10px]`, `rounded-t-[0.6rem]`). Welded to one number the way a
//      px font size is, and unnameable besides. The migration found none; it is banned so the fix
//      cannot come back wearing a hat.
//   4. A raw `border-radius` declaration in an absolute unit (the per-corner longhands included,
//      `border-top-left-radius` and the logical `border-start-start-radius` alike, and the JS
//      `borderRadius` spelling a `:style` binding uses), in a stylesheet or a `<style>` block,
//      where no utility class exists for rules 1 and 2 to catch. Its `var()` is read rather than
//      waved through, so `var(--radius-4xl)` and the bare `var(--radius)` are caught where rule 2
//      would catch them in utility form. A scoped
//      `<style>` block reaches the scale through `var(--ui-radius)`, NOT `var(--radius-sm)`: Nuxt
//      UI declares the `--radius-*` scale `@theme default inline`, so Tailwind emits those only
//      when the COMPILED stylesheet graph references them. Unlike the font-size guard, `rem`
//      is claimed too: a rem radius tracks the ROOT FONT SIZE, which is a different theme knob, so
//      it no more follows `--ui-radius` than a px one does.
//
// NOT banned, because neither is a step that should scale: `rounded-full` (pills, avatars, the
// `9999px` / `50%` spellings of the same intent) and `rounded-none` / `border-radius: 0`.
//
// A UTILITY is read only where a utility can live: inside a `class=` attribute value, a
// single-quoted or template string, after `@apply`, or in an unterminated `class="` plus the lines
// a wrapped attribute continues onto. `rounded` is also an ordinary English word, and scanning the
// whole line failed a template's `<p>Fully rounded corners</p>` and a trailing
// `// value is rounded` with a message about a radius that is not there. A double-quoted span is
// that same prose with quotes around it (`alt="rounded avatar"`), which is why that arm is anchored
// on the attribute name; an apostrophe is not a quote, so the single-quoted arm takes word
// boundaries instead. A raw declaration is read anywhere on the line, because CSS is not quoted.
//
// Policy: ZERO offenders, no ratchet. A line that genuinely needs a fixed radius says why with a
// `radius-literal-ok:` comment, on that line or the one before it; nothing in the tree needs one.
//
// Usage:  node scripts/check-frontend-radius.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The layer AND the deployment template, the same two roots `check-frontend-palette.mjs` scans:
// `deploy/frontend` is what a consumer copies, so a fixed radius there ships as the pattern to copy.
const SCAN_ROOTS = [
  join(repoRoot, 'frontend', 'app', 'app'),
  join(repoRoot, 'deploy', 'frontend', 'app'),
]

// The seven steps Nuxt UI rebinds onto `--ui-radius`. Anything else is a literal, `rounded-4xl`
// (Tailwind's own 2rem, left alone by Nuxt UI) and a typo alike.
const THEME_STEPS = new Set(['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'])
// Not steps, so they have no scale to follow and are always fine.
const NOT_A_STEP = new Set(['full', 'none'])
// Every side and corner suffix Tailwind gives the utility. Logical (`s`/`e`, `ss`/`se`/`ee`/`es`)
// and physical (`t`/`r`/`b`/`l`, `tl`/`tr`/`br`/`bl`) both, because the SPA is RTL-aware and uses
// the logical forms; a guard that knew only the physical ones would pass `rounded-ss`.
const SIDES = new Set([
  'tl',
  'tr',
  'br',
  'bl',
  'ss',
  'se',
  'ee',
  'es',
  't',
  'r',
  'b',
  'l',
  's',
  'e',
])

// The WHOLE utility token, side and step and arbitrary value included, so the decision is made by
// reading its parts rather than by a regex that has to tell `rounded-s` from `rounded-sm`.
// `(?<![\w-])` is a LEFT boundary: without it `group-rounded` matches on a substring. `(?![\w-])`
// closes the right end, so a token is claimed whole or not at all.
// An INTERPOLATION is a step too (`rounded-${step}`, `rounded-t-${size}`). Without that arm the
// right boundary rejects the whole token on the `-` before `${`, so a computed class is not
// classified at all and a `size` resolving to `4xl` ships past a zero-tolerance guard. The step is
// unresolvable here, so it can never be one of the seven and is reported off-scale.
const UTILITY_TOKEN = /(?<![\w-])rounded(?:-(?:\[[^\]]*\]|\$\{[^}]*\}|[A-Za-z0-9]+))*(?![\w-])/g
// Where a utility can live: a `class=` attribute value, a single-quoted or template string, an
// `@apply` argument, or an unterminated `class="` that a wrapped attribute continues on the lines
// below.
// The double-quoted arm is ANCHORED on `class=` (`:class=` and `active-class=` included, the `\b`
// sitting where the prefix ends) because a bare double-quoted span is the shape of ordinary
// English prose: `alt="rounded avatar"`, `describe("rounded corners")` and a sentence saying a
// value is rounded all read as a class list otherwise, and the waiver that silences them would
// state something untrue. Nothing is lost by the anchor, because the formatter writes every
// TypeScript string single-quoted and a class list holds no apostrophe to force the other quote.
// The single-quoted arm needs boundaries instead: an apostrophe is not a quote, so
// `It's a rounded corner, don't` would otherwise read as one quoted span and flag prose that has
// no class list in it (the reason `presets.ts` needs its path exemption).
const QUOTED = /(?<=\bclass=)"[^"]*"|(?<![A-Za-z0-9])'[^']*'(?![A-Za-z0-9])|`[^`]*`/g
const APPLY = /@apply\b[^;]*/g
const OPEN_CLASS = /:?class=["'][^"']*$/
// The continuation of a wrapped attribute: everything up to the quote that closes it. Paired with
// the `openClassList` state main() carries, so a class list wrapped over three lines is read on all
// three rather than only on the one carrying `class="`.
const CLASS_CONTINUATION = /^[^"']*/
// A raw declaration's VALUE, up to the `;` or the `}` that ends it. The per-corner longhands are
// claimed too, physical and logical alike: `border-top-left-radius: 4px` is the same defect as the
// shorthand, and contains no `border-radius:` substring for a shorthand-only pattern to find.
const DECLARATION =
  /border-(?:(?:top|bottom|start|end)-(?:left|right|start|end)-)?radius:\s*([^;}]*)/g
// The same declaration spelled as a JS style property, which is how a Vue `:style` binding and a
// direct `element.style` assignment write it. No utility class exists there either, so the rule is
// the shorthand's; only the property name differs, and a camelCase name contains no `border-radius`
// substring for `DECLARATION` to find. The separator is `:` in an object literal and `=` in an
// `element.style` assignment, and a JS value ends at a `,` as well as a `;` or a `}`.
const STYLE_PROPERTY =
  /border(?:(?:Top|Bottom|Start|End)(?:Left|Right|Start|End))?Radius\s*[:=]\s*([^,;}]*)/g
// `9999px` and friends are `rounded-full` spelled in CSS: a pill, not a step. They are removed from
// the value rather than suppressing the whole line, so the `8px` in `50% 50% 8px 8px` still counts.
// The left boundary keeps the removal from reaching INSIDE a longer number: without it `4999px`
// loses its `999px` and the leftover `4` carries no unit, so a real literal reads as clean.
const PILL_VALUE = /(?<![\d.])(?:9999px|999px|100vmax|50%|100%)/g
// px, rem or em. `0` and `50%` carry no absolute unit and so never match.
const ABSOLUTE = /\d*\.?\d+(?:px|rem|em)/
// A `var()` is only as good as the variable it names, so the value is read rather than waved
// through: `--radius-xs` through `--radius-3xl` are the seven Nuxt UI rebinds, and anything else is
// a literal hiding behind a variable. `var(--radius-4xl)` is Tailwind's own 2rem and `var(--radius)`
// is the deprecated alias inlined as 0.25rem, which is rule 1 and rule 2 spelled in CSS. The
// capture is the step, absent for the bare alias. `var(--ui-radius)` is the scale variable itself
// and does not match, the `--ui-` prefix sitting where `--radius` would start.
const RADIUS_VAR = /var\(\s*--radius(?:-([A-Za-z0-9]+))?\s*\)/g
const LITERAL_OK = 'radius-literal-ok:'
// A line that opens with a comment marker is prose about the rule, not an application of it. Two
// characters look like markers and are NOT: in a `.css` file a leading `#` is an ID selector, and a
// leading `*` is the UNIVERSAL selector, so `* { border-radius: 4px }` is a rule to check and not a
// JSDoc continuation. What tells them apart is what follows: a selector continues into `{`, `,` or
// another combinator, where a comment continues into prose.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*(?!\s*[,{]|[:.#[>+~*])|<!--)/
// A trailing comment is prose too, and `COMMENT_LINE` only sees a line that OPENS with one. The
// quoted `rounded` in `const n = 1 // was 'rounded' before #2251` is a note about this rule, not a
// class list, and the README invites writing exactly that. `//` opens a comment only after
// whitespace or at the start of the line: in `https://...` it follows a colon.
const TRAILING_COMMENT = /(?:^|\s)\/\/.*$|\/\*.*?\*\/|<!--.*?-->/g

/** The offending shape a `rounded-*` token carries, or null when it follows the theme. */
function classifyUtility(token) {
  const parts = token.split('-').slice(1)
  if (parts.some((part) => part.startsWith('['))) return 'arbitrary'
  if (SIDES.has(parts[0])) parts.shift()
  if (parts.length === 0) return 'bare'
  if (parts.length === 1 && (THEME_STEPS.has(parts[0]) || NOT_A_STEP.has(parts[0]))) return null
  return 'off-scale'
}

/** Every non-scaling radius on a CODE line (deduplicated), or [] for a clean or exempted line. The
 * `radius-literal-ok:` waiver is honoured on the line itself OR on the line before it (the
 * `eslint-disable-next-line` shape), so a waiver never forces the class off its own line. Pure, so
 * the companion test can drive it with fixture strings. */
export function findFixedRadii(line, prevLine = '', openClassList = false) {
  if (COMMENT_LINE.test(line)) return []
  if (line.includes(LITERAL_OK) || prevLine.includes(LITERAL_OK)) return []

  const code = stripComments(line)
  const classContext = [
    ...(openClassList ? (code.match(CLASS_CONTINUATION) ?? []) : []),
    ...(code.match(QUOTED) ?? []),
    ...(code.match(APPLY) ?? []),
    ...(code.match(OPEN_CLASS) ?? []),
  ].join(' ')
  const utilities = (classContext.match(UTILITY_TOKEN) ?? []).filter(classifyUtility)

  const declarations = []
  for (const pattern of [DECLARATION, STYLE_PROPERTY]) {
    for (const [match, value] of code.matchAll(pattern)) {
      const property = match.match(/^[^:=]*/)[0].trim()
      const trimmed = value.trim().replace(/^["']|["']\s*$/g, '')
      if (isFixedValue(trimmed)) declarations.push(`${property}: ${trimmed}`)
    }
  }

  return [...new Set([...utilities, ...declarations])]
}

/** Whether a declaration's VALUE is welded to a number: an absolute unit outside the pill
 * spellings, or a `var()` naming a step Nuxt UI does not rebind. */
function isFixedValue(value) {
  if (ABSOLUTE.test(value.replaceAll(PILL_VALUE, ''))) return true
  return [...value.matchAll(RADIUS_VAR)].some(([, step]) => !step || !THEME_STEPS.has(step))
}

/** A line with its comments blanked, so a `rounded` a developer WROTE ABOUT is not read as one they
 * applied. Exported for the companion test; `main()` reaches it through `findFixedRadii`. */
export function stripComments(line) {
  return line.replaceAll(TRAILING_COMMENT, ' ')
}

/** Whether the class attribute is still open once this line has been read. A wrapped attribute
 * opens on the line carrying `class="` and closes on the first quote after it, so the lines in
 * between are class list too. Pure, so the companion test can drive the wrap as a sequence. */
export function tracksOpenClassList(line, openClassList = false) {
  const code = stripComments(line)
  if (openClassList) return !/["']/.test(code)
  return OPEN_CLASS.test(code)
}

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === 'dist') continue
    const abs = join(dirAbs, entry)
    if (statSync(abs).isDirectory()) {
      yield* sourceFiles(abs)
    } else if (
      abs.endsWith('.vue') ||
      abs.endsWith('.ts') ||
      abs.endsWith('.css') ||
      abs.endsWith('.html')
    ) {
      // Beyond `.vue`: a class list can be built in a composable (`.ts`, as `ImageCompare.vue`'s
      // canvas class is), applied with `@apply` (`.css`), and `spa-loading-template.html` is
      // hand-written CSS that renders before the app does.
      yield abs
    }
  }
}

function main() {
  const offenders = []
  for (const file of SCAN_ROOTS.flatMap((root) => [...sourceFiles(root)])) {
    const rel = relative(repoRoot, file).replaceAll('\\', '/')
    // The one exemption, for the same reason `check-frontend-palette.mjs` grants it: a verbatim copy
    // of the Nuxt UI editor's preset table, stored only so a share link rebuilds and never rendered
    // by the SPA. Its prose describes radii it does not apply.
    if (rel.endsWith('frontend/app/app/utils/theme/presets.ts')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    let openClassList = false
    lines.forEach((line, i) => {
      const matches = findFixedRadii(line, lines[i - 1] ?? '', openClassList)
      if (matches.length) offenders.push({ file: rel, line: i + 1, matches })
      openClassList = tracksOpenClassList(line, openClassList)
    })
  }

  if (offenders.length) {
    console.error('Corner radii that do not follow the theme are banned in the SPA (issue #2251).')
    console.error(
      'Use a NAMED step: `rounded-xs` through `rounded-3xl` all derive from `--ui-radius`, so a\n' +
        "theme document's `radius` reaches them. Bare `rounded` (and `rounded-t`, `rounded-bl`, ...)\n" +
        'is a Tailwind v3 alias inlined as a literal 0.25rem, which is why a theme used to round the\n' +
        'buttons and leave the boxes behind; `rounded-sm` is that same 0.25rem at the default theme.\n' +
        '`rounded-4xl` is off the scale too: Nuxt UI rebinds only xs through 3xl, so 4xl keeps\n' +
        "Tailwind's literal 2rem.\n" +
        'In a stylesheet reached from `main.css`, `border-radius: var(--radius-xs|sm|md|lg|xl|2xl|3xl)`,\n' +
        'one of the seven rebinds and never `var(--radius-4xl)` or the bare `var(--radius)`; in a\n' +
        "component's own scoped `<style>` block, `var(--ui-radius)` / `calc(var(--ui-radius) * N)`,\n" +
        'which is the scale variable itself and so needs no Tailwind emission.\n' +
        '`rounded-full` and `rounded-none` are fine.\n' +
        'A line that genuinely needs a fixed radius says why with a `radius-literal-ok:` comment, on\n' +
        'that line or the one above. See frontend/app/README.md, "Radius through the theme scale".\n',
    )
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    }
    console.error(`\n${offenders.length} line(s) with a radius that ignores the theme.`)
    process.exit(1)
  }

  console.log('check-frontend-radius: every corner radius in the SPA follows --ui-radius.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
