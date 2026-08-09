---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
---

Let a generative binary integration declare SEVERAL credentials, so a key/secret pair is two named
values rather than one colon-joined string.

`BinaryGeneratorDefinition.credential` held one lookup name, resolved to one value, injected as one
environment variable. That fits a bearer token and nothing else: an integration authenticating with
HTTP Basic over an API key and an API secret (Twilio, Mailgun and a long tail of REST APIs), an
access key paired with its secret, or a key scoped by an account id, has two facts and one field to
put them in. The workaround was to store `key:secret` in one variable and explain the join in
`usage`, which loses nothing about safety and three things about operations: the capability-credential
checklist asks a board for one value the vendor's console never issues, the halves can only be
rotated together, and a value assembled wrongly arrives as a 401 indistinguishable from a wrong key,
which is a failure an operator debugs against the vendor rather than against the declaration.

**Breaking for a deployment that registers a generative integration**: the field is now
`credentials`, a list, and the singular spelling is gone rather than kept as sugar for a list of one.
Two spellings for one fact means every reader handles both and the next author copies whichever they
saw first, and this surface is deployment CODE, so the break arrives as a typecheck failure at the
composition root instead of at a dispatch months later. Wrap the existing declaration in an array;
nothing else about it changes.

```ts
credentials: [
  { key: 'SCENARIO_API_KEY', usage: 'the HTTP Basic username' },
  { key: 'SCENARIO_API_SECRET', usage: 'the HTTP Basic password' },
]
```

Each credential keeps its own `envName`, `usage` and `required`, and each must land in a DISTINCT
environment variable (case-insensitively, since environment lookup is on Windows), refused at
registration: two entries under one name would both resolve and one would silently overwrite the
other. An integration's whole list is resolved in ONE `ToolSecretResolver` call, so a per-workspace
sealed store is not asked once per value. The agent's brief names every variable and states the
missing-value disposition jointly, because a pair with one half missing must not be sent at all, and
per-variable instructions leave "send what arrived" as the plausible reading.

No auth SCHEME field comes with this, deliberately. The agent writes the request here, so a scheme
would be a fact the platform stores and never acts on, and the first vendor with a signed request
would need an enum member nobody can add; `usage` stays prose because prose covers every scheme.

**Mothership-mode deployments roll both processes together for this release.** A node on this build
refuses a mothership reply carrying the retired singular field, with the same
`binary_generators_unreachable` outage refusal an older mothership's 404 already produces. Reading
that reply as "declares none" would have told the agent to call a metered vendor API unauthenticated
and report the 401 as the endpoint's fault, which is a silent wrong answer with a version skew behind
it. An ABSENT list is still read as an integration that authenticates with nothing.
