import type { ApiContractFormat, UploadApiContract } from '@cat-factory/contracts'
import { ValidationError, isOpenApiDocument } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Write-boundary validation for an UPLOADED contract document.
//
// The point is to refuse a document that will read as garbage to a downstream agent at the
// moment someone uploads it, rather than at the moment a coder is handed it. The check is
// per-format and deliberately shallow:
//
//   - `openapi` is PARSED — a document claiming to be OpenAPI but which is not is the failure
//     mode that produces a service whose catalog entry lists zero operations while looking
//     perfectly registered.
//   - the two TypeScript formats are checked only for the LIBRARY IMPORT they claim. They
//     cannot be evaluated (no code generation in a Worker isolate, and executing an uploaded
//     module would be a remote-code-execution hole), so the honest check is that the document
//     is what its declared format says it is; the agent reads the source itself.
// ---------------------------------------------------------------------------

/** The package import each TypeScript contract format is recognised by. */
const REQUIRED_IMPORT: Partial<Record<ApiContractFormat, { package: string; label: string }>> = {
  'toad-contract': { package: '@toad-contracts/', label: '@toad-contracts/core' },
  'lokalise-api-contract': { package: '@lokalise/api-contract', label: '@lokalise/api-contract' },
}

/**
 * Refuse an uploaded contract whose body does not match its declared format. Throws a
 * `ValidationError` carrying a machine-readable `reason` the SPA maps to translated copy;
 * returns silently when the document is acceptable.
 */
export function validateUploadedContract(upload: UploadApiContract): void {
  if (upload.format === 'openapi') {
    if (!isOpenApiDocument(upload.body)) {
      throw new ValidationError(
        `Contract '${upload.contractId}' is not a valid OpenAPI 3.x document (JSON or YAML)`,
        { reason: 'invalid_openapi_document', contractId: upload.contractId },
      )
    }
    return
  }
  const required = REQUIRED_IMPORT[upload.format]
  if (required && !upload.body.includes(required.package)) {
    throw new ValidationError(
      `Contract '${upload.contractId}' does not reference ${required.label}`,
      {
        reason: 'contract_library_not_referenced',
        contractId: upload.contractId,
        expected: required.label,
      },
    )
  }
}
