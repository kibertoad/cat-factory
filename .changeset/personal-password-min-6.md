---
'@cat-factory/contracts': patch
'@cat-factory/app': patch
---

Lower the personal-subscription password minimum from 8 to 6 characters.

The personal password that gates the second encryption layer on individual-usage
subscription credentials now requires at least 6 characters (was 8). Updated the
`personalPasswordSchema` contract and the matching client-side guards/labels in the
store and unlock UIs. The account login/reset password is unaffected.
