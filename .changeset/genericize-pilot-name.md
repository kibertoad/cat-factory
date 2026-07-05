---
'@cat-factory/contracts': patch
'@cat-factory/integrations': patch
---

chore(environments): genericize the stack-recipes pilot name in code + fixtures

Replace the real company name used as the stack-recipes pilot with the neutral `acme`
placeholder across the code comments and detection test fixtures (`acme-main`, `acme-net`,
`deployment/acme-db-dummy/*.sql`, …). Behaviour-neutral: the detection fixtures rename both
the input and the expected assertion in lockstep, so the golden tests are unchanged.
