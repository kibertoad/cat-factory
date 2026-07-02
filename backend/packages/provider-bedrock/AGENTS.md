# `@cat-factory/provider-bedrock` — opt-in AWS Bedrock model registry

Mix into a `CompositeModelProvider` to add the `bedrock` provider. Carries a supported-model
allow-list (throws `Unsupported Bedrock model` for anything outside it). One of the opt-in
`provider-*` packages; wired only when configured. Single-file: `src/index.ts`.
