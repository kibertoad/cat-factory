---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A step whose capability credential is missing now parks instead of failing.

- A dispatch that throws the new `CapabilityCredentialMissingError` parks the step on a capability
  credential wait recording the key, the subject that declared it, its label, the onboarding
  instructions and what the agent observed. The run panel shows them, links to the
  capability-credentials panel, and any member resumes once the key is stored; a premature resume
  is refused with `capability_credential_still_missing`.
- `PipelineStep.credentialWait` is now a union on `subject` (`personal`, `capability`). A wait
  persisted before this release decodes as `unrecorded` rather than being read as personal: it
  cannot be resumed (`credential_wait_unrecorded`), and its run must be restarted. Internal break.
- A new `research-definition` capability-credential subject resolves from the credential store
  only, never from the deployment's environment.
- Public API: `capability_credential_missing` and `credential_wait_unrecorded` join the
  unanswerable-wait reasons (OpenAPI 1.95.0, SDKs regenerated).
