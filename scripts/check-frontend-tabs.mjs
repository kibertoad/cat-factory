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
// read from a literal in either quote style (`role="tab"`, `role='tab'`) or a bound string literal
// (`:role="'tab'"`). A computed `:role` is not read: its value is decided at runtime.
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

const ROLE = new RegExp(
  `\\s(?:role=(?:"(${TAB_ROLES.join('|')})"|'(${TAB_ROLES.join('|')})')` +
    `|(?::|v-bind:)role=(?:"'(${TAB_ROLES.join('|')})'"|'"(${TAB_ROLES.join('|')})"'))(?=[\\s/>])`,
)

/** Every hand-stated tab role in one `.vue` source, as `[{ line, role }]`. */
export function findTabRoles(source) {
  const raw = source.split('\n')
  const found = []
  walkTemplate(source, {
    open(node) {
      const m = ROLE.exec(node.tag)
      if (!m || isWaivedAbove(raw, node.line, WAIVER)) return
      found.push({ line: node.line, role: m.slice(1).find(Boolean) })
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
