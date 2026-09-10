---
'@cat-factory/agents': patch
---

Have the `mocker` agent pin WireMock to the latest **stable** release.

The mock-builder role prompt now instructs the agent to check what the newest stable
(non-prerelease) `wiremock/wiremock` version is at the moment it sets up the mocks and pin
the image / dependency to that exact tag — rather than hard-coding an older version or using
a floating `latest` tag. This keeps generated services on a current, reproducible WireMock
without the prompt itself going stale as new releases ship.
