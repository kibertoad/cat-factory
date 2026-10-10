// Extract the connection-failure cause vocabulary from its canonical source and from each of the
// four SDKs' PORTED copies, so a drift check can compare them.
//
// The four clients under `sdk/` declare no dependencies by design, so kernel's
// `ConnectionFailureCause` (owned by `@cat-factory/contracts`, because the SPA holds the
// translated copy per member) cannot be imported into them: each transport re-states the
// vocabulary against the codes, exception types and errnos its own runtime produces. Four copies
// is the accepted cost of the no-dependency promise. What was NOT accepted, and what this module
// exists for, is those copies drifting silently: nothing in a per-language unit test can see the
// contracts picklist, so a member added or retired there left four clients answering an older
// vocabulary and no test anywhere went red.
//
// Only the MEMBER SET is compared. What each runtime matches a member ON is genuinely
// per-language (a Go `syscall.Errno`, a JDK exception type, an undici `code`) and pinned by that
// SDK's own tests; the set is the part that has to agree.
//
// Parsed rather than imported for the same reason the copies exist: this file runs as pure node
// with no install, in the always-on repo-guards job, and three of the four sources are not
// JavaScript.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where each vocabulary lives, relative to the repo root. */
export const CAUSE_SOURCES = {
  contracts: 'backend/packages/contracts/src/provider-config.ts',
  typescript: 'sdk/typescript/src/diagnosis.ts',
  python: 'sdk/python/cat_factory/_diagnosis.py',
  go: 'sdk/go/diagnosis.go',
  java: 'sdk/java/src/main/java/ai/catfactory/sdk/ConnectionDiagnosis.java',
}

/** Read the block a declaration opens, so a member list is never matched across an unrelated one. */
function blockAfter(source, opener, closer) {
  const start = source.indexOf(opener)
  if (start === -1) return null
  const end = source.indexOf(closer, start + opener.length)
  if (end === -1) return null
  return source.slice(start + opener.length, end)
}

/**
 * Drop comments before any member is read.
 *
 * Not defensive tidying: a member list is documented INSIDE the list in three of these four files,
 * and prose quotes things. A comment reading "kept apart from 'timeout'" would otherwise be
 * extracted as a member, and one reading "the client's own" would open a quote that swallows the
 * rest of the line. Both read as a vocabulary that agrees or disagrees for a reason that has
 * nothing to do with the vocabulary.
 *
 * All three comment syntaxes are stripped from every block. No member is a `#` or a `//`, so
 * applying a language's syntax to another language's file cannot remove one.
 */
function stripComments(block) {
  return block
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/[^\n]*/g, '')
    .replaceAll(/#[^\n]*/g, '')
}

/** Every single-quoted or double-quoted kebab-case member in a block, comments removed first. */
function quotedMembers(block) {
  return [...stripComments(block).matchAll(/['"]([a-z][a-z-]*)['"]/g)].map((match) => match[1])
}

/**
 * The canonical vocabulary: the `connectionFailureCauseSchema` picklist in contracts.
 *
 * This is the one list the SPA's exhaustive `Record` and kernel's classifier are both built from,
 * which is what makes it the source rather than one more copy.
 */
export function readCanonicalCauses(source) {
  const block = blockAfter(source, 'connectionFailureCauseSchema = v.picklist([', '])')
  if (block === null) return null
  return quotedMembers(block)
}

/** The TypeScript client's `TransportFailureCause` union. */
export function readTypescriptCauses(source) {
  const block = blockAfter(source, 'export type TransportFailureCause =', '\n\n')
  if (block === null) return null
  return quotedMembers(block)
}

/**
 * The Python client's `CAUSES` tuple.
 *
 * Anchored to the start of a line, because a bare `CAUSES = (` is a SUFFIX of any renamed
 * constant ending in the same word: without the newline, renaming it to `TRANSPORT_CAUSES` would
 * still parse, and the guard would report a vocabulary difference for a declaration it was no
 * longer really reading.
 */
export function readPythonCauses(source) {
  const block = blockAfter(source, '\nCAUSES = (', ')')
  if (block === null) return null
  return quotedMembers(block)
}

/** The Go client's `failureCause` constants, whose VALUES are the wire spellings. */
export function readGoCauses(source) {
  const block = blockAfter(source, 'const (', ')')
  if (block === null) return null
  return [...stripComments(block).matchAll(/failureCause = "([a-z][a-z-]*)"/g)].map(
    (match) => match[1],
  )
}

/**
 * The Java client's `Cause` enum, whose members are SCREAMING_SNAKE rather than kebab-case.
 *
 * Lowered to the wire spelling here so the comparison is over one vocabulary rather than two, and
 * so a Java member misspelled in a way that happens to lower correctly is still a member that
 * agrees. Java is the only one of the four whose spelling differs, because an enum constant
 * cannot carry a hyphen.
 */
export function readJavaCauses(source) {
  const block = blockAfter(source, 'enum Cause {', '}')
  if (block === null) return null
  return stripComments(block)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Z][A-Z_]*$/.test(entry))
    .map((entry) => entry.toLowerCase().replaceAll('_', '-'))
}

const READERS = {
  typescript: readTypescriptCauses,
  python: readPythonCauses,
  go: readGoCauses,
  java: readJavaCauses,
}

/**
 * Compare every ported vocabulary against the canonical one.
 *
 * Returns one problem per disagreement, naming the SDK and both directions of the difference:
 * "missing" is a member the platform can produce and that client cannot name, and "extra" is a
 * member that client claims and the platform retired. They need opposite fixes, so they are
 * reported apart rather than as one "does not match".
 *
 * A source that could not be PARSED is a problem too, never a pass: a renamed declaration would
 * otherwise turn this guard off silently, which is the same class of failure it exists to catch.
 */
export function compareCauseVocabularies(readFile) {
  const problems = []
  const canonicalSource = readFile(CAUSE_SOURCES.contracts)
  const canonical = readCanonicalCauses(canonicalSource)
  if (canonical === null || canonical.length === 0) {
    return [
      `could not read the canonical vocabulary from ${CAUSE_SOURCES.contracts}: ` +
        'the `connectionFailureCauseSchema` picklist was not found where this guard looks for it.',
    ]
  }
  const expected = new Set(canonical)

  for (const [sdk, read] of Object.entries(READERS)) {
    const path = CAUSE_SOURCES[sdk]
    const members = read(readFile(path))
    if (members === null || members.length === 0) {
      problems.push(
        `${sdk}: could not read the ported vocabulary from ${path}. ` +
          'The declaration this guard parses was renamed or reshaped; update the reader in ' +
          '`scripts/sdk-connection-causes.mjs` rather than leaving it unable to look.',
      )
      continue
    }
    const found = new Set(members)
    const missing = canonical.filter((cause) => !found.has(cause))
    const extra = members.filter((cause) => !expected.has(cause))
    if (missing.length > 0) {
      problems.push(
        `${sdk} (${path}) cannot name ${missing.join(', ')}, which the platform's ` +
          '`connectionFailureCauseSchema` can produce. Add the member and the sentence it renders.',
      )
    }
    if (extra.length > 0) {
      problems.push(
        `${sdk} (${path}) names ${extra.join(', ')}, which the platform's ` +
          '`connectionFailureCauseSchema` no longer has. Retire it here too.',
      )
    }
  }
  return problems
}

/** Read a repo-relative path as UTF-8, for the entry point. */
export function repoReader(root) {
  return (path) => readFileSync(join(root, path), 'utf8')
}
