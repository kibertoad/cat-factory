---
'@cat-factory/server': patch
---

A mothership-mode node now rebuilds a remote repository's `unavailable`, `unauthorized` and `rate_limited` refusals as `DomainError`s. They used to come back as plain errors, so the node answered 500 and dropped `details.reason`. The rebuilt-code table is a `Record` over `DomainErrorCode`, so a new code fails the typecheck until someone decides how the client treats it.
