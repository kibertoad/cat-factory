---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
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
sealed store is not asked once per value.

The same one-owner-per-variable rule now holds ACROSS integrations, where it was previously a
first-wins dedupe. Two integrations declaring one injection name is two values and one slot in the
agent's environment, and the credential resolver is subject-scoped by design, so the second cannot be
handed its own value there. A step selecting both now gives the name to the first and withholds the
second's credentials WHOLE, with the brief telling that agent the variable holds another
integration's value and that it must not call the integration at all. Dropping only the clashing half
left it holding one vendor's key beside its own secret, signing a request with the pair, and reading
the 401 as a revoked credential. Boot additionally WARNS
(`binary_generator_credential_name_collision`) when two registered definitions name one variable; the
remedy is a distinct `envName` on one of them, which may keep the same lookup `key`, so a shared
vendor account still resolves from a single deployment variable.

The agent's brief names every variable and states each missing-value disposition under the quantifier
that rule actually has. A REQUIRED value is stated jointly and fires on ANY missing part, because a
pair with one half missing must not be sent at all and per-variable instructions leave "send what
arrived" as the plausible reading. An OPTIONAL value is stated per value, because each was declared
skippable on its own: an agent given one of two optional values sends the one it has instead of
discarding both.

No auth SCHEME field comes with this, deliberately. The agent writes the request here, so a scheme
would be a fact the platform stores and never acts on, and the first vendor with a signed request
would need an enum member nobody can add; `usage` stays prose because prose covers every scheme.

**Mothership-mode deployments roll both processes together for this release.** A node on this build
refuses a mothership reply carrying the retired singular field, with the same
`binary_generators_unreachable` outage refusal an older mothership's 404 already produces. Reading
that reply as "declares none" would have told the agent to call a metered vendor API unauthenticated
and report the 401 as the endpoint's fault, which is a silent wrong answer with a version skew behind
it. An ABSENT list is still read as an integration that authenticates with nothing.
