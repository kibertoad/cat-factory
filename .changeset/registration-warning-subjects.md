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
standards beside a late-bound `src:<sourceId>:<slug>` reference can now fail boot on the typo and
keep the warning on the late-bound id:

```ts
escalateRegistrationWarning: (p) =>
  p.code === 'task_type_unknown_fragment' && !p.subject.startsWith('src:'),
```

The platform's own severity is unchanged: both are still warnings by default, because boot cannot
tell a typo from a tenant-tier id. Design record: ADR 0063.

INTERNAL BREAK (pre-1.0, no shim): `RegistrationProblem` is now a union of `RegistrationError` and
`RegistrationWarning`, and only the warn branch carries `subject`. Code constructing a problem by
hand, or reading `subject` off the union, must narrow on `severity` first. An
`escalateRegistrationWarning` predicate written against the previous signature keeps compiling: its
parameter is narrowed to `RegistrationWarning`, and every field it could read is still present.
