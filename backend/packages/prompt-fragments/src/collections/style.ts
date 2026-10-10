import type { PromptFragment } from '@cat-factory/contracts'

// Universal WRITING-STYLE fragments for the document-authoring track. Unlike the
// technical collections (node/react/acceptance/design), these are source- and
// stack-neutral: they govern HOW prose is written, not what a service is built with.
// They fold into the document-authoring kinds via the `doc-aware` trait (the same
// engine path `code-aware` uses for the technical fragments), and are pre-selected by
// default on a document task (see `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`), user-removable
// like any block pin. Because the `doc-reviewer` companion also carries `doc-aware`, the
// SAME bodies reach it as review criteria — style guidance is both an instruction to the
// writer and a check by the reviewer.

export const styleFragments: PromptFragment[] = [
  {
    id: 'style.anti-llmisms',
    version: '1.0.0',
    title: 'Avoid LLM tells',
    category: 'Writing style',
    summary:
      'Cut the machine-written tells: filler adverbs, hedging, throat-clearing, bullet inflation.',
    body: [
      'Write like a human editor, not a language model. Avoid the tells that mark machine-written prose:',
      '- Drop filler intensifiers and cliches: "delve", "crucial", "vital", "seamless", "robust",',
      '  "leverage", "utilize" (write "use"), "in the realm of", "navigate the landscape",',
      '  "it is important to note", "it is worth noting", "when it comes to".',
      '- Cut throat-clearing and hedging: "In today\'s fast-paced world", "As we all know",',
      '  "It goes without saying", "Needless to say", "Arguably", "In conclusion". State the point.',
      '- No summary that merely restates what was just said, and no section that only previews',
      '  the next one. Every paragraph must add information.',
      '- Do not inflate into bullet lists what is a sentence, and do not end every bullet with a',
      '  parallel flourish. Use a list only for genuinely enumerable items.',
      '- Do not overuse em-dashes, rhetorical questions, or the "It\'s not just X, it\'s Y" frame.',
      '- Prefer plain, specific words over vague grandeur. Concrete nouns and real numbers beat',
      '  adjectives. If a sentence survives deletion with no loss of meaning, delete it.',
    ].join('\n'),
  },
  {
    id: 'style.concise-actionable',
    version: '1.0.0',
    title: 'Concise and actionable',
    category: 'Writing style',
    summary:
      'Lead with the point, active voice, one idea per paragraph; every recommendation names an actor and an action.',
    body: [
      'Write to be read fast and acted on:',
      '- Lead with the conclusion. Put the answer, decision, or recommendation in the first',
      '  sentence of a section, then support it. Do not build up to it.',
      '- Active voice, present tense, second person where you address the reader. Name the actor:',
      '  "the operator restarts the worker", not "the worker should be restarted".',
      '- One idea per paragraph; one job per sentence. Break a long sentence into short ones.',
      '- Every recommendation is actionable: it names WHO does WHAT, and when it applies. Replace',
      '  "consideration should be given to caching" with "cache the catalog response for 60s".',
      '- Prefer concrete examples, commands, and tables over abstract description.',
      '- Cut ruthlessly. Say it once, in the fewest words that stay precise. Length is not thoroughness.',
    ].join('\n'),
  },
]

/**
 * The style fragments a NEW document task is pre-seeded with (default-on, user-removable
 * like any block pin). The source of truth for "which style fragments a document task
 * starts with" — the board service seeds these onto a document task's `fragmentIds` at
 * creation, so the `doc-aware` authoring/review kinds fold them in without the prompt
 * hard-coding the guidance.
 */
export const DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS: readonly string[] = [
  'style.anti-llmisms',
  'style.concise-actionable',
]
