# @cat-factory/observability-otel

## 0.1.12

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/kernel@0.136.0

## 0.1.11

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0

## 0.1.10

### Patch Changes

- @cat-factory/kernel@0.134.1

## 0.1.9

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0

## 0.1.8

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0

## 0.1.7

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0

## 0.1.6

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0

## 0.1.5

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0

## 0.1.4

### Patch Changes

- @cat-factory/kernel@0.129.2

## 0.1.3

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.1.2

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0

## 0.1.1

### Patch Changes

- @cat-factory/kernel@0.128.1

## 0.1.0

### Minor Changes

- d68e3a8: Add opt-in OpenTelemetry (OTLP) observability. A new `@cat-factory/observability-otel`
  package implements the kernel `LlmTraceSink` port and exports LLM generations (+ container
  tool spans) and metrics to any OTLP/HTTP backend — a workerd-safe fetch exporter on the
  Cloudflare Worker facade and the official `@opentelemetry/*` SDK exporter on Node, kept
  conformant by a shared mapping layer + a conformity test.

  - **kernel:** new `CompositeTraceSink` + `composeTraceSinks` so multiple external trace
    destinations (Langfuse and/or OTLP) fan out through the single sink slot.
  - **server:** new `OtelConfig` on `AppConfig`.
  - **worker / node-server:** wire the OTLP exporter (fetch on the Worker, SDK on Node)
    everywhere the Langfuse sink is wired, composed alongside Langfuse. Enabled with
    `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (`OTEL_EXPORTER_OTLP_HEADERS` /
    `OTEL_SERVICE_NAME` optional).
  - **cli:** advertise the `OTEL_*` vars in the generated `.env`.

  Refinements: the Node facade shares ONE trace-sink instance across the core, the container
  executor and the inline model-provider (so the SDK exporter's batch processors/timers aren't
  duplicated) and flushes + shuts it down on graceful shutdown (via `LlmTraceSink.shutdown` /
  `CompositeTraceSink` fan-out) so the final batch isn't dropped. Metric data points carry only
  the low-cardinality `gen_ai.*` dimensions — the unbounded workspace id stays on spans, off
  metrics — to keep metric-backend cardinality bounded.

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
