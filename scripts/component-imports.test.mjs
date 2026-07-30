// Fixtures for the unresolved-layer-component detector. Run with `node --test scripts/` — the
// built-in runner, so CI's `repo-guards` job stays install-free like every other guard in it.
//
// The bug this guard catches is invisible (an unresolved tag renders nothing, silently), so a guard
// that quietly stopped detecting it would look exactly like a clean tree. The cases below are the
// ones that decide whether it works: the real shapes it must flag, and the four ways a tag is
// legitimately resolved that it must NOT flag.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bindsComponent,
  findUnresolvedComponents,
  registeredComponentName,
  splitByCase,
  templateBlock,
  usedComponentTags,
} from './component-imports.mjs'

const index = {
  layerComponents: new Map([
    ['StepEffortReport', new Set(['frontend/app/app/components/panels/StepEffortReport.vue'])],
    ['StepTestReport', new Set(['frontend/app/app/components/panels/StepTestReport.vue'])],
    ['AgentKindIcon', new Set(['frontend/app/app/components/pipeline/AgentKindIcon.vue'])],
    ['AppRoot', new Set(['frontend/app/app/components/AppRoot.vue'])],
  ]),
  bareRegistered: new Set(['AppRoot']),
}

const tagsOf = (src) => findUnresolvedComponents(src, index).map((f) => f.tag)

const sfc = (script, template) =>
  `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n${template}\n</template>\n`

describe('findUnresolvedComponents', () => {
  it('flags a layer component used with no import', () => {
    // The shape that shipped seven times: the tag reads fine, and Nuxt registered the component
    // as `PanelsStepEffortReport`, so it renders nothing.
    assert.deepEqual(tagsOf(sfc('', '<StepEffortReport :report="r" />')), ['StepEffortReport'])
  })

  it('accepts a default import', () => {
    const src = sfc(
      "import StepEffortReport from '~/components/panels/StepEffortReport.vue'",
      '<StepEffortReport :report="r" />',
    )
    assert.deepEqual(tagsOf(src), [])
  })

  it('accepts a named import, including an aliased neighbour in the same clause', () => {
    const src = sfc(
      "import { AgentKindIcon as Icon, StepEffortReport } from '~/components/kit'",
      '<StepEffortReport /><AgentKindIcon />',
    )
    // `AgentKindIcon` is bound by the clause even though it is aliased away, which is enough:
    // the guard's question is whether the name is auto-registration-free, not whether it is used.
    assert.deepEqual(tagsOf(src), [])
  })

  it('accepts a local binding (async component, resolveComponent)', () => {
    const src = sfc(
      "const StepEffortReport = defineAsyncComponent(() => import('~/components/panels/StepEffortReport.vue'))",
      '<StepEffortReport />',
    )
    assert.deepEqual(tagsOf(src), [])
  })

  it('does not flag a component Nuxt registers under its bare name', () => {
    // Directly in `components/`, so the path prefix is empty and `<AppRoot>` really does resolve.
    assert.deepEqual(tagsOf(sfc('', '<AppRoot />')), [])
  })

  it('ignores tags that are not layer components', () => {
    const src = sfc('', '<UButton /><NuxtLink /><JourneyHost /><Transition />')
    assert.deepEqual(tagsOf(src), [])
  })

  it('flags each distinct unresolved tag once, sorted', () => {
    const src = sfc('', '<StepTestReport /><AgentKindIcon /><StepTestReport />')
    assert.deepEqual(tagsOf(src), ['AgentKindIcon', 'StepTestReport'])
  })

  it('reports where the component is defined, so the fix is copy-pasteable', () => {
    const [finding] = findUnresolvedComponents(sfc('', '<AgentKindIcon />'), index)
    assert.deepEqual(finding.definedAt, ['frontend/app/app/components/pipeline/AgentKindIcon.vue'])
  })

  it('ignores a same-named TYPE used in a script generic', () => {
    // The one false positive found on the real tree: `computed<FrontendConfig>(...)` in a script
    // block matched a naive `<Tag` scan. Scoping to the template block is what rules it out.
    const src = sfc('const c = computed<StepEffortReport>(() => x)', '<div />')
    assert.deepEqual(tagsOf(src), [])
  })
})

describe('templateBlock', () => {
  it('spans the outer template, keeping inner template wrappers', () => {
    const src = sfc('', '<template v-if="x"><StepEffortReport /></template>')
    assert.match(templateBlock(src), /<StepEffortReport \/>/)
  })

  it('excludes the script block', () => {
    assert.doesNotMatch(templateBlock(sfc('const a = 1', '<div />')), /const a/)
  })

  it('is empty for an SFC with no template', () => {
    assert.equal(templateBlock('<script setup>const a = 1</script>'), '')
  })
})

describe('usedComponentTags', () => {
  it('requires the name to end, so a prefix is not read as a use', () => {
    // `<StepTestReport` must not also count as a use of `<StepTest`.
    assert.deepEqual([...usedComponentTags('<StepTestReport />')], ['StepTestReport'])
  })

  it('counts an opening tag once, not its closing partner', () => {
    assert.deepEqual([...usedComponentTags('<Foo>x</Foo>')], ['Foo'])
  })

  it('ignores lowercase HTML elements', () => {
    assert.deepEqual([...usedComponentTags('<div><span /></div>')], [])
  })
})

describe('registeredComponentName', () => {
  // The rule the first version of this guard lacked, which made it report seven working files.
  // Every expectation below was cross-checked against Nuxt's own generated `.nuxt/components.d.ts`
  // (all 228 components matched), so these are Nuxt's answers, not this port's opinion.
  it('prefixes with the directory path', () => {
    assert.equal(registeredComponentName('panels/StepEffortReport.vue'), 'PanelsStepEffortReport')
    assert.equal(registeredComponentName('pipeline/AgentKindIcon.vue'), 'PipelineAgentKindIcon')
    assert.equal(registeredComponentName('board/nodes/BlockNode.vue'), 'BoardNodesBlockNode')
    assert.equal(
      registeredComponentName('panels/inspector/DocReferenceRepos.vue'),
      'PanelsInspectorDocReferenceRepos',
    )
  })

  it('deduplicates a prefix segment the filename already repeats', () => {
    // Why `<PipelinePicker>` works bare while `<AgentKindIcon>` in the same folder does not.
    assert.equal(registeredComponentName('pipeline/PipelinePicker.vue'), 'PipelinePicker')
    assert.equal(registeredComponentName('merge/MergeEffortChips.vue'), 'MergeEffortChips')
    assert.equal(registeredComponentName('kaizen/KaizenStepStatus.vue'), 'KaizenStepStatus')
  })

  it('leaves a root-level component unprefixed', () => {
    assert.equal(registeredComponentName('AppRoot.vue'), 'AppRoot')
  })
})

describe('splitByCase', () => {
  it('splits on case transitions and separators', () => {
    assert.deepEqual(splitByCase('StepEffortReport'), ['Step', 'Effort', 'Report'])
    assert.deepEqual(splitByCase('prReview'), ['pr', 'Review'])
    assert.deepEqual(splitByCase('foo-bar_baz'), ['foo', 'bar', 'baz'])
  })

  it('keeps an acronym together, breaking before the next word', () => {
    assert.deepEqual(splitByCase('PRReviewWindow'), ['PR', 'Review', 'Window'])
  })
})

describe('bindsComponent', () => {
  it('does not match a mere substring of another identifier', () => {
    assert.equal(bindsComponent("import StepEffortReportCard from 'x'", 'StepEffortReport'), false)
    assert.equal(
      bindsComponent("import { StepEffortReportCard } from 'x'", 'StepEffortReport'),
      false,
    )
  })

  it('matches a default import in a multi-clause statement', () => {
    assert.equal(bindsComponent("import Foo, { bar } from 'x'", 'Foo'), true)
  })

  it('matches a named import spanning lines', () => {
    assert.equal(bindsComponent("import {\n  a,\n  Foo,\n} from 'x'", 'Foo'), true)
  })
})
