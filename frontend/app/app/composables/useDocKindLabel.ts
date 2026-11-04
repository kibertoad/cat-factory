import type { DocKind } from '~/types/domain'

// One static, typed message key per document kind. The exhaustive Record means adding a DocKind
// fails typecheck until it has a label here, and the literal keys keep the i18n drift check live.
const DOC_KIND_LABEL_KEYS: Record<DocKind, string> = {
  prd: 'documents.kinds.prd',
  rfc: 'documents.kinds.rfc',
  adr: 'documents.kinds.adr',
  design: 'documents.kinds.design',
  technical: 'documents.kinds.technical',
  api: 'documents.kinds.api',
  runbook: 'documents.kinds.runbook',
  research: 'documents.kinds.research',
  reference: 'documents.kinds.reference',
  other: 'documents.kinds.other',
}

/**
 * A document kind's label, never its id. Shared by the add-task form and the template manager
 * so the two pickers name the kinds identically.
 */
export function useDocKindLabel() {
  const { t } = useI18n()
  return (kind: DocKind): string => t(DOC_KIND_LABEL_KEYS[kind])
}
