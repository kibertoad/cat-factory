#!/usr/bin/env node
// Bans a hand-built tab bar in the SPA: an element that states the ARIA tab roles itself
// (issue #2246, one sub-navigation pattern).
//
// Switching between views inside one surface is Nuxt UI's `UTabs`. It renders Reka's `TabsRoot`,
// which gives the `tablist` / `tab` / `tabpanel` roles, `aria-selected`, a roving tab stop and the
// arrow keys. A row of buttons that states `role="tablist"` and `role="tab"` by hand looks the
// same to a screen reader but has none of the keyboard behaviour: guided review had one, and the
// arrow keys did nothing in it.
//
// SCOPE: every opening tag in the TEMPLATE half of a `.vue` file under the SPA roots. A role is
// read wherever the template states it as a literal: a plain attribute in either quote style
// (`role="tab"`, `role='tab'`), any string or template literal inside a bound `:role` expression
// (`:role="'tab'"`, ``:role="`tab`"``, `:role="tabbed ? 'tab' : undefined"`), and the same inside
// the `role` key of a `v-bind="{ … }"` object, which `check-frontend-variants.mjs` reads too. A
// `:role` with no literal in it (`:role="kind"`) is not read: its value is decided at runtime.
//
// What this guard does NOT see: a row of `UButton`s that switches views with no roles at all. A
// tab bar and an option picker (a row that sets a value) have the same markup, so the difference
// is a review question, written down in `frontend/app/README.md` ("Switch views inside a surface
// with `UTabs`").
//
// Policy: ZERO offenders. A site that must state a tab role itself says why with a `tabs-ok:`
// comment on its own line, directly above the tag; it waives that tag only.
//
// Usage:  node scripts/check-frontend-tabs.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readFileSync } from 'node:fs'
import { isCliEntry, isWaivedAbove, spaSourceFiles, walkTemplate } from './lib/frontend-scan.mjs'

const WAIVER = 'tabs-ok:'

/** The ARIA roles that only a tab widget states. */
export const TAB_ROLES = ['tablist', 'tab', 'tabpanel']

const NAMES = TAB_ROLES.join('|')
const PLAIN = new RegExp(`\\srole=(?:"(${NAMES})"|'(${NAMES})')(?=[\\s/>])`)
const BOUND = /\s(?::|v-bind:)role=(?:"([^"]*)"|'([^']*)')/
const OBJECT_SPREAD = /\sv-bind=(?:"\s*\{([^"]*)\}\s*"|'\s*\{([^']*)\}\s*')/
const OBJECT_ROLE = /(?:^|[,\s])(['"]?)role\1\s*:\s*([^,]*)/
const LITERAL = new RegExp(`(['"\`])(${NAMES})\\1`)

/** The first tab role an expression states as a string or template literal, or `undefined`. */
function literalRole(expression) {
  return expression ? LITERAL.exec(expression)?.[2] : undefined
}

/** The tab role one opening tag states as a literal, or `undefined`. */
function statedRole(tag) {
  const plain = PLAIN.exec(tag)
  if (plain) return plain[1] ?? plain[2]
  const bound = BOUND.exec(tag)
  const fromBound = bound && literalRole(bound[1] ?? bound[2])
  if (fromBound) return fromBound
  const spread = OBJECT_SPREAD.exec(tag)
  const key = spread && OBJECT_ROLE.exec(spread[1] ?? spread[2])
  return key ? literalRole(key[2]) : undefined
}

/** Every hand-stated tab role in one `.vue` source, as `[{ line, role }]`. */
export function findTabRoles(source) {
  const raw = source.split('\n')
  const found = []
  walkTemplate(source, {
    open(node) {
      const role = statedRole(node.tag)
      if (!role || isWaivedAbove(raw, node.line, WAIVER)) return
      found.push({ line: node.line, role })
    },
  })
  return found
}

function main() {
  const offenders = []
  for (const file of spaSourceFiles()) {
    if (!file.rel.endsWith('.vue')) continue
    for (const hit of findTabRoles(readFileSync(file.abs, 'utf8'))) {
      offenders.push({ file: file.rel, ...hit })
    }
  }

  if (offenders.length) {
    console.error('A template states an ARIA tab role by hand.')
    console.error(
      'Switch between views inside a surface with `UTabs`: it gives the tab roles AND the arrow\n' +
        'keys, which a row of buttons with `role="tab"` does not. See frontend/app/README.md,\n' +
        '"Switch views inside a surface with `UTabs`". A site that must state the role itself\n' +
        'says why in a `<!-- tabs-ok: … -->` comment directly above the tag.\n',
    )
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  role="${o.role}"`)
    console.error(`\n${offenders.length} hand-built tab role(s).`)
    process.exit(1)
  }

  console.log('check-frontend-tabs: no template states an ARIA tab role by hand.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
