// Generated candidates for the login task's sign-in illustration, compared before one is stored.
// Two come from Nano Banana and are staged in the platform's own asset storage, so they have a
// preview; one comes from `acme-imagen` through the org's private `acme-media` store, which issues
// no link, so it has none. Nano Banana and the platform storage are real (`nano-banana.ts` in
// binary-generators, `platform-asset-service.ts` in kernel); the rest is made up.
import type { BinaryCandidate, BinaryCandidateStepState } from '@cat-factory/contracts'

/** The artifact ids of the two candidates with a preview, as the blob read answers them. */
export const CALM_HERO = 'art_cand_calm'
export const BOLD_HERO = 'art_cand_bold'

const subject = 'hero:sign-in'

export const heroCandidates: BinaryCandidate[] = [
  {
    id: 'cand_calm',
    label: 'Calm',
    generator: 'nano-banana',
    subject,
    service: 'platform-assets',
    location: CALM_HERO,
    contentType: 'image/png',
    note: 'Soft palette, the illustration sits right of the form.',
  },
  {
    id: 'cand_bold',
    label: 'Bold',
    generator: 'nano-banana',
    subject,
    service: 'platform-assets',
    location: BOLD_HERO,
    contentType: 'image/png',
    note: 'High contrast, the illustration fills the background.',
  },
  {
    id: 'cand_flat',
    label: 'Flat',
    generator: 'acme-imagen',
    subject,
    service: 'acme-media',
    location: 'heroes/sign-in/flat-v1.png',
    contentType: 'image/png',
    note: 'Flat shapes in the brand colours.',
  },
]

/** The comparison waiting for a person to keep one candidate. */
export function candidateState(
  overrides: Partial<BinaryCandidateStepState> = {},
): BinaryCandidateStepState {
  return {
    status: 'awaiting_choice',
    candidates: heroCandidates,
    multiSelect: false,
    invalidEntries: 0,
    omitted: 0,
    unusablePreviews: 0,
    ...overrides,
  }
}
