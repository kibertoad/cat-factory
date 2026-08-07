---
'@cat-factory/worker': patch
---

Export the log lines the Worker's durable drivers emit. The five `WorkflowEntrypoint` classes are
entry points workerd starts in their own isolates, and they applied neither the `LOG_LEVEL`
threshold nor the OTLP log sink, so a deployment with `OTEL_LOGS=true` collected everything the
request, cron and queue paths logged and nothing from the engine itself. Each wake now applies the
settings on entry and drains before every durable suspension (`step.sleep` / `step.waitForEvent`
hand the isolate, and its buffer, back mid-run) as well as in a `finally`.
