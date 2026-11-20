---
'@cat-factory/agents': patch
---

Have the `mocker` agent pin WireMock to the newest stable release when it adds WireMock to a
repository.

The mock-builder role prompt now tells the agent to look the version up at run time (the
`wiremock/wiremock` tags on Docker Hub, or `org.wiremock:wiremock` on Maven Central), pin the
highest plain `X.Y.Z` release instead of the floating `latest` tag, and report a failed lookup
rather than guess a number. A repository that already pins WireMock keeps its pin: the agent
flags an outdated one. A frontend run is told not to add WireMock at all, because the platform
serves its mappings with its own pinned build.
