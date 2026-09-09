---
---

Add a LiteLLM gateway integration lane: the `litellm` resolver over real HTTP against a real
LiteLLM proxy in Docker, calling a canned OpenAI-compatible upstream the suite stands up itself, so
no provider key is configured and no tokens are billed. Test-only, no shipped code changed.
