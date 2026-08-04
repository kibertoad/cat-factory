# cat-factory Go SDK

Go client for the cat-factory **public API** (`/api/v1`).

```sh
go get github.com/kibertoad/cat-factory/sdk/go@latest
```

Go 1.23+ (for `iter.Seq`). **No dependencies outside the standard library.**

```go
import catfactory "github.com/kibertoad/cat-factory/sdk/go"

client, err := catfactory.New(catfactory.Options{
    BaseURL: "https://cat-factory.example.com",
    APIKey:  os.Getenv("CAT_FACTORY_API_KEY"),
})
if err != nil {
    return err
}

services, err := client.Services.List(ctx)
if err != nil {
    return err
}
taskType := "feature"
task, err := client.Tasks.Create(ctx, services.Services[0].ServiceID, catfactory.CreatePublicTask{
    Title:    "Add a health check endpoint",
    TaskType: &taskType,
})
```

Every method takes a `context.Context` first and honours its cancellation.

## Resource services

`Jobs`, `Services`, `Tasks`, `Pipelines`, `Notifications`, `Usage`, `Decisions`, `Debug`:
one per tag of the published OpenAPI surface. Every call is scoped to the key's workspace.

## Watching a run

```go
stream, err := client.Tasks.Stream(ctx, taskID)
if err != nil {
    return err
}
defer stream.Close()

for event := range stream.Events() {
    if event.Event == "decision" {
        // The run PARKED on a human decision and waits indefinitely. Answer it through
        // client.Decisions (needs a `decide`-scope key) or free it with Tasks.Stop.
    }
    if event.Event == "done" || event.Event == "error" {
        break
    }
    // `timeout` means the deployment's connection cap was reached, NOT that the run finished.
}
// Always check: a stream that ended because the socket dropped is not one that ended on a
// terminal event, and only Err tells them apart.
if err := stream.Err(); err != nil {
    return err
}
```

## Paging

Range-over-func, so a mid-iteration failure surfaces instead of silently truncating the walk:

```go
for task, err := range client.Tasks.ListByServiceAll(ctx, serviceID, nil) {
    if err != nil {
        return err
    }
    fmt.Println(task.TaskID)
}
```

## Errors

Test the status class with the `Is*` helpers; branch on the specific cause with `HasCode`, which
takes a plain string because this surface adds new codes without a major version.

```go
task, err := client.Tasks.Get(ctx, taskID)
switch {
case catfactory.IsNotFound(err):
    return nil, nil
case catfactory.HasCode(err, "insufficient_scope"):
    return nil, errors.New("this key needs a higher scope")
case err != nil:
    return nil, err
}
```

`*APIError` carries `Status`, `Code`, `Details`, `Issues` and the `RequestID` to quote when
reporting a fault. `*ConnectionError` and `*DecodeError` are the transport-level failures; all
work with `errors.As` / `errors.Is`.

## Pointers

A field is a **pointer** when the value can be genuinely absent or genuinely null; Go's zero
values cannot express either, so `Progress: 0` and "no progress reported" would otherwise be the
same value. A plain field is one the contract guarantees is always sent.

## Local development and mocks

The base URL takes any origin (`http://localhost:8787`, a fixture server, a mock) and no scheme
validation is applied. Each client also accepts a custom transport, so you can intercept in-process
instead. See [the SDK guide](../README.md#pointing-an-sdk-at-localhost-or-a-mock).

## Notes

- `models_gen.go` and `operations_gen.go` are generated; see [`../README.md`](../README.md).
- API reference: [`backend/docs/public-api.md`](../../backend/docs/public-api.md).
