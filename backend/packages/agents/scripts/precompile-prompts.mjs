// Precompiles the standard-prompt Handlebars templates into a static spec module.
//
// Why: the worker runs on Cloudflare Workers, which forbid runtime code
// generation (`new Function`/`eval`). Handlebars' normal `compile()` generates
// code at render time, so it cannot run there. Precompiling turns each template
// into a plain data/function spec that the codegen-free Handlebars *runtime*
// (`Handlebars.template`) can execute. The generated specs are committed and
// imported as ordinary source — no eval, no build-time magic at consume time.
//
// Regenerate after editing any template below:
//   pnpm --filter @cat-factory/agents run precompile:templates

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Handlebars from 'handlebars'

// Shared context preamble, included by every phase template via {{> blockContext}}.
const BLOCK_CONTEXT_PARTIAL = [
  'Pipeline: {{pipelineName}}',
  'Block: {{block.title}} ({{block.type}})',
  'Description: {{#if block.description}}{{block.description}}{{else}}(none provided){{/if}}',
  '{{#if features.length}}Target features: {{join features ", "}}{{/if}}',
  '{{#if decisions.length}}',
  'Resolved decisions:',
  '{{#each decisions}}- {{question}} → {{chosen}}',
  '{{/each}}{{/if}}',
  '{{#if priorOutputs.length}}',
  'Work from earlier agents in this pipeline:',
  '{{#each priorOutputs}}### {{agentKind}}',
  '{{output}}',
  '',
  '{{/each}}{{/if}}',
].join('\n')

// The phase-specific closing instruction appended after the shared context.
const USER_TASKS = {
  design:
    'Produce the solution design for this block. Be concise and concrete: prefer short bullets over prose, and finish with the ordered implementation steps.',
  build:
    'Produce the implementation for this block, faithful to the design and prior work above: the key modules, functions, data shapes and wiring.',
  review:
    'Review the work above. List concrete, actionable findings ordered by severity; if it is sound, say so explicitly.',
  test: 'Produce a pragmatic test plan for this block: the highest-value tests to write first, the key edge cases and the failure modes to cover.',
}

const PHASES = Object.keys(USER_TASKS)

const entries = [
  ['blockContext', BLOCK_CONTEXT_PARTIAL],
  ...PHASES.map((phase) => [phase, `{{> blockContext}}\n${USER_TASKS[phase]}`]),
]

const specs = entries
  .map(([name, src]) => `export const ${name} = ${Handlebars.precompile(src, { noEscape: true })}`)
  .join('\n\n')

const header = `// @ts-nocheck
// GENERATED FILE — DO NOT EDIT BY HAND.
// Precompiled Handlebars specs for the standard-prompt templates, consumed by the
// codegen-free Handlebars runtime so the worker can render them on Cloudflare
// Workers (which forbid runtime code generation).
//
// Regenerate with: pnpm --filter @cat-factory/agents run precompile:templates
// Source templates live in scripts/precompile-prompts.mjs.

/* eslint-disable */

`

const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'agents',
  'standard-prompt-templates.generated.ts',
)

writeFileSync(outPath, `${header}${specs}\n`)
console.log(`Wrote ${outPath}`)
