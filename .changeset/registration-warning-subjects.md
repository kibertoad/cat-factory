---
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

A boot-validation warning now names ONE structured `subject`, so `escalateRegistrationWarning` can
dispose of a mixed fragment declaration per id.

`task_type_unknown_fragment` reports one warning per unresolved id instead of batching a
declaration's ids into one, and every warning carries the id it is about as data rather than only
interpolated into its message. A deployment whose `defaultFragmentIds` names code-registered
standards beside a late-bound tenant-tier reference can now fail boot on the typo and keep the
warning on the late-bound id, by testing the namespace its own standards live under:

```ts
escalateRegistrationWarning: (p) =>
  p.code === 'task_type_unknown_fragment' && p.subject.startsWith('acme.'),
```

Test that namespace positively. The inverse (`!p.subject.startsWith('src:')`) reads as the same rule
and is not one: a hand-authored account-tier row and a repo-sourced file pinning its own frontmatter
`id` both carry a plain slug, so it fails boot on exactly the tenant-tier reference it means to
spare.

The platform's own severity is unchanged: both are still warnings by default, because boot cannot
tell a typo from a tenant-tier id. Design record: ADR 0063.

Two reports also stop arriving in duplicate: a repeated id in one declaration is one warning, and a
tool-server definition shared across kinds is checked once, naming every kind it is declared for. A
blank `defaultFragmentIds` entry is now an ERROR (no tier resolves a blank id, so it cannot be a
late-bound reference).

INTERNAL BREAK (pre-1.0, no shim): `RegistrationProblem` is now a union of `RegistrationErrorProblem`
and `RegistrationWarning`, and only the warn branch carries `subject`; its `code` is the closed
`RegistrationWarnCode` union. Code constructing a problem by hand, or reading `subject` off the
union, must narrow on `severity` first. An `escalateRegistrationWarning` predicate written against
the previous signature keeps compiling: its parameter is narrowed to `RegistrationWarning`, and
every field it could read is still present. The two credential warnings
(`oauth_header_collision`, `unused_credential_env_name`) name the TOOL SERVER as their subject
rather than the credential key, which several servers may share.
