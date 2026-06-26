---
---

CI: fix the `prod-deployed` marker existence check in deploy.yml. The probe used the
legacy plural `git/refs/{ref}` endpoint, which lists refs by prefix and can answer 200
with an array on a partial match (e.g. a `prod-deployed-foo` tag), making the "does the
marker exist?" branch unreliable. Switch the probe to the single-reference endpoint
`git/ref/{ref}` (200 on exact match, 404 otherwise); create/update keep the plural POST
`git/refs` / PATCH `git/refs/{ref}` endpoints, which are the correct ones for those.
