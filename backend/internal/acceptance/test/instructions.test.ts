import { describe, expect, it } from 'vitest'
import { backendScaffoldBrief, frontendScaffoldBrief } from '../src/instructions.ts'

const TARGETS = {
  ingressHostTemplate: '{{namespace}}.127.0.0.1.nip.io',
  imageTemplate: 'ghcr.io/{{repoOwner}}/{{repoName}}:pr-{{pullNumber}}',
}

/**
 * Both briefs, because `manifestBrief` is folded into each and a rule added to one caller only is
 * exactly the drift this pins: the backend and the frontend both ship an Ingress, and a pass fails
 * at whichever of them the platform provisions first.
 */
const BRIEFS = {
  backend: backendScaffoldBrief(TARGETS),
  frontend: frontendScaffoldBrief('cf-acc-catalog-api', TARGETS),
}

describe.each(Object.entries(BRIEFS))('%s scaffold brief', (_role, brief) => {
  it('tells the agent to leave the ingress class unset', () => {
    // The rule exists because an agent with no instruction picks a plausible controller name, and
    // the plausible one is `nginx`. A k3d/k3s cluster runs Traefik, so that Ingress is accepted by
    // the apiserver, claimed by nothing, and its URL never answers while every workload reports
    // healthy — the exact shape that cost a 43-minute pass. Leaving the class unset lets the
    // cluster's DEFAULT IngressClass take it, which is the portable answer: it works on a Traefik
    // cluster and an nginx one alike, where naming either would break the other.
    expect(brief).toContain('Do NOT set `ingressClassName`')
    expect(brief).toContain('DEFAULT IngressClass')
  })

  it('still pins the ingress HOST, which is the sibling rule and a different failure', () => {
    // PR #2075's half. Both are needed and neither implies the other: the host decides WHERE the
    // name points, the class decides whether anything is listening for it.
    expect(brief).toContain(TARGETS.ingressHostTemplate)
  })

  it('names no concrete ingress controller anywhere, which would re-create the bug', () => {
    // A brief that says "use traefik" is the same defect with a different value: it would fail on
    // every cluster that runs something else.
    expect(brief).not.toMatch(/ingressClassName:\s*\w/)
    expect(brief.toLowerCase()).not.toContain('ingressclassname: nginx')
  })
})
