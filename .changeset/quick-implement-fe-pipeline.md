---
"@cat-factory/kernel": minor
---

Add the "Quick implement (FE)" built-in pipeline (`pl_quick_fe`): identical to "Quick
implement" but with the UI tester (`tester-ui`) in place of the API tester (`tester-api`),
so the test step drives a real browser against the frontend instead of exercising the API.
