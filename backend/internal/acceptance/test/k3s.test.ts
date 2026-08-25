import { describe, expect, it } from 'vitest'
import {
  hostSuffix,
  imageTemplateSample,
  renderEnvironmentHost,
  renderEnvironmentImage,
  renderEnvironmentNamespace,
} from '../src/k3s.ts'

// The two manifest templates the briefs make mandatory, rendered the way the platform renders them
// at provision time: an unfilled hole is the empty string, which is a Deployment the apiserver
// refuses three agents into a pass (see `src/manifestTemplates.ts`).

describe('renderEnvironmentHost', () => {
  it('renders the namespace hole', () => {
    expect(renderEnvironmentHost('{{namespace}}.127.0.0.1.nip.io', 'cf-acc-7')).toBe(
      'cf-acc-7.127.0.0.1.nip.io',
    )
  })

  it('renders a padded hole, because the platform does', () => {
    // `renderTemplate` matches `{{\s*key\s*}}`, so `{{ namespace }}` is a template that WORKS in
    // production. Reading only the unpadded spelling refused it here, in the name of rendering
    // exactly as the platform does, before the pass had spent anything.
    expect(renderEnvironmentHost('{{ namespace }}.127.0.0.1.nip.io', 'cf-acc-7')).toBe(
      'cf-acc-7.127.0.0.1.nip.io',
    )
  })

  it('reports a template it cannot fully render rather than emitting a broken host', () => {
    // `{{pullNumber}}` is not known before a run opens its pull request, so guessing at it would
    // produce a host nothing resolves and a preflight that passed.
    expect(renderEnvironmentHost('{{branch}}-{{namespace}}.example', 'ns')).toBeNull()
  })

  it('still refuses a hole that is not hole-SHAPED, on either spelling', () => {
    // A placeholder is `{{someName}}` with no punctuation inside, so `{{repo-owner}}` matches the
    // substitution on neither side and survives verbatim into a host nothing resolves.
    expect(renderEnvironmentHost('{{ repo-owner }}.example', 'ns')).toBeNull()
  })
})

describe('renderEnvironmentImage', () => {
  const sample = imageTemplateSample({ owner: 'kibertoad', name: 'cf-acc-catalog-api' })

  it('renders the default template', () => {
    const verdict = renderEnvironmentImage(
      'ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}',
      sample,
    )
    expect(verdict).toEqual({ ok: true, rendered: 'ghcr.io/kibertoad/cf-acc-catalog-api:pr-1' })
  })

  it('refuses {{namespace}}, which the platform renders the image one step too early to know', () => {
    // The trap this sample's key set exists for: `{{namespace}}` is a hole in the manifests and in
    // the ingress host, so it reads as a per-PR value an image may be built from. It is not.
    // `provisionContext` renders the image template against the bare inputs and only THEN adds the
    // namespace, so a gate that sampled one would pass a template the platform renders to
    // `ghcr.io/o/r:`, the empty image this whole check exists to refuse.
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{namespace}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('{{namespace}}')
  })

  it('accepts a template built from an input the deployer really supplies', () => {
    // The other half of the same rule: a key MISSING from the sample refuses a working template
    // and names the wrong vocabulary doing it. `blockId` is supplied on every provision, primary
    // frame or peer.
    expect(renderEnvironmentImage('ghcr.io/o/r:{{blockId}}', sample)).toEqual({
      ok: true,
      rendered: `ghcr.io/o/r:${sample.blockId}`,
    })
  })

  it('refuses a hole that is not hole-SHAPED, in the name half as well as the tag', () => {
    // `{{repo-owner}}` matches no placeholder on either side, so it survives rendering verbatim and
    // reaches the apiserver as a reference with braces in it. The tag half was covered by accident
    // through the tag charset; the name half was not covered at all.
    const verdict = renderEnvironmentImage('ghcr.io/{{repo-owner}}/r:pr-{{pullNumber}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('brace')
  })

  it('refuses a prototype member, which is not a value any provision fills', () => {
    // `{{toString}}` matches the hole charset and finds a FUNCTION up the prototype chain, so a
    // nullish read reported it as filled and spliced `function toString() { [native code] }` in.
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{toString}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('{{toString}}')
  })

  it('refuses a stray space rather than trimming one the platform would keep', () => {
    // `renderTemplate` trims nothing, so a gate that trimmed reported a reference the platform
    // would never produce, from the one input shape a `.env` line does not clean up for you.
    const verdict = renderEnvironmentImage('ghcr.io/o/r: pr-{{pullNumber}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('whitespace')
  })

  it('names a placeholder a provision does not fill rather than emitting the empty string', () => {
    // Exactly what the platform does with an unknown key, minus the silence: a manifest applied
    // with `image: ""` is refused by the apiserver as a Deployment whose image is missing, which
    // accuses the manifest of a fault that belongs to the configuration.
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{commitSha}}', sample)
    expect(verdict).toMatchObject({ ok: false })
    expect(verdict.ok ? '' : verdict.problem).toContain('{{commitSha}}')
  })

  it('refuses a tag with a slash in it, because that is what {{branch}} renders', () => {
    const verdict = renderEnvironmentImage('ghcr.io/o/r:{{branch}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain("may not contain '/'")
  })

  it('refuses a reference with no tag, which could never be the code under review', () => {
    const verdict = renderEnvironmentImage('ghcr.io/o/r', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('no tag')
  })

  it('keeps a registry port out of the tag reading', () => {
    // `localhost:5000/app` has a colon that is not a tag separator, so a naive split reports a
    // perfectly good reference as untagged.
    expect(renderEnvironmentImage('localhost:5000/app:pr-{{pullNumber}}', sample)).toEqual({
      ok: true,
      rendered: 'localhost:5000/app:pr-1',
    })
    expect(renderEnvironmentImage('localhost:5000/app', sample).ok).toBe(false)
  })

  it('refuses an uppercase name, and points at where it came from', () => {
    const verdict = renderEnvironmentImage('ghcr.io/{{repoOwner}}/r:pr-1', {
      ...sample,
      repoOwner: 'Lokalise',
    })
    expect(verdict.ok ? '' : verdict.problem).toContain('ACCEPTANCE_REPO_OWNER')
    // And says what it cannot promise: the platform re-derives the owner from the pull request URL,
    // so a lowercase ACCEPTANCE_REPO_OWNER is not evidence the reference stays lowercase.
    expect(verdict.ok ? '' : verdict.problem).toContain('pull request URL')
  })

  it('blames no variable for an uppercase letter the template hard-codes', () => {
    // The remedy is instructions: naming ACCEPTANCE_REPO_OWNER for a name that never asked for the
    // owner sends a reader to edit a variable that is not in the reference.
    const verdict = renderEnvironmentImage('ghcr.io/Lokalise/r:pr-{{pullNumber}}', sample)
    expect(verdict.ok ? '' : verdict.problem).toContain('not lowercase')
    expect(verdict.ok ? '' : verdict.problem).not.toContain('ACCEPTANCE_REPO_OWNER')
  })
})

describe('hostSuffix', () => {
  it('keeps only the fixed tail, which is all a scenario can honestly assert', () => {
    expect(hostSuffix('{{namespace}}.127.0.0.1.nip.io')).toBe('.127.0.0.1.nip.io')
    expect(hostSuffix('{{branch}}.{{namespace}}.preview.example.com')).toBe('.preview.example.com')
  })

  it('returns a template with no holes unchanged', () => {
    expect(hostSuffix('preview.example.com')).toBe('preview.example.com')
  })
})

describe('renderEnvironmentNamespace', () => {
  const sample = imageTemplateSample({ owner: 'acme', name: 'catalog-api' })

  it('renders the per-PR holes a namespace template may name', () => {
    expect(renderEnvironmentNamespace('cf-acc-pr{{pullNumber}}', sample)).toBe('cf-acc-pr1')
    expect(renderEnvironmentNamespace('{{repoName}}-pr{{pullNumber}}', sample)).toBe(
      'catalog-api-pr1',
    )
  })

  it('lowercases, because the platform sanitizes to an RFC1123 label', () => {
    expect(renderEnvironmentNamespace('CF-ACC-PR{{pullNumber}}', sample)).toBe('cf-acc-pr1')
  })

  it('reports a hole no provision fills, rather than rendering it away', () => {
    // Left verbatim so the brace check catches it: rendering it to '' would produce a plausible
    // namespace here and a different one on the platform, which is the drift these renderers
    // exist to prevent.
    expect(renderEnvironmentNamespace('cf-acc-{{commitSha}}', sample)).toBeNull()
    expect(renderEnvironmentNamespace('cf-acc-{{pull number}}', sample)).toBeNull()
  })

  it('does not fill {{namespace}}, which is what it PRODUCES', () => {
    expect(renderEnvironmentNamespace('{{namespace}}-x', sample)).toBeNull()
  })
})
