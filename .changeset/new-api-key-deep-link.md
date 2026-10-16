---
'@cat-factory/app': minor
---

An integration can now send a person to mint their own API key. `?newApiKey=1` opens the API tokens
window with the create form filled in from `label`, `scope` and `runsAsSelf=1` (the personal
identity, where someone is signed in to bind it to), and `ws` pins the board. Nothing is minted
until the person clicks create, and signing in first keeps the link.
