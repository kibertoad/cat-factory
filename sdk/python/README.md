# `cat-factory-sdk`

Python client for the cat-factory **public API** (`/api/v1`).

```sh
pip install cat-factory-sdk
```

Python 3.11+. **No dependencies**: the transport is `urllib` from the standard library, so
installing this cannot conflict with whatever HTTP stack your application already uses.

```python
import os
from cat_factory import CatFactoryClient
from cat_factory.models import CreatePublicTask, StartPublicTask

client = CatFactoryClient(
    base_url="https://cat-factory.example.com",
    api_key=os.environ["CAT_FACTORY_API_KEY"],
)

services = client.services.list().services
task = client.tasks.create(
    services[0].service_id,
    CreatePublicTask(title="Add a health check endpoint", task_type="feature"),
)
client.tasks.start(task.task_id, StartPublicTask())
```

Wire names are `camelCase`; attributes are `snake_case`.

## Resource clients

`jobs`, `services`, `tasks`, `pipelines`, `notifications`, `webhook`, `usage`, `decisions`,
`debug`:
one per tag of the published OpenAPI surface. Every call is scoped to the key's workspace.

## Watching a run

```python
with client.tasks.stream(task.task_id) as stream:
    for event in stream:
        if event.event == "decision":
            # The run PARKED on a human decision and waits indefinitely. Answer it through
            # `client.decisions` (needs a `decide`-scope key) or free it with `tasks.stop`.
            payload = event.json()
        if event.event in ("done", "error"):
            break
        # `timeout` means the deployment's connection cap was reached, NOT that the run finished.
```

Use it as a context manager (or call `close()`) so the socket is released.

## Paging

```python
for task in client.tasks.list_by_service_all(service_id):
    print(task.task_id)
```

## Errors

The exception CLASS comes from the HTTP status; `code` carries the specific cause and is a plain
string, because this surface adds new codes without a major version.

```python
from cat_factory import CatFactoryForbiddenError, CatFactoryNotFoundError

try:
    client.tasks.get(task_id)
except CatFactoryNotFoundError:
    return None
except CatFactoryForbiddenError as exc:
    if exc.code == "insufficient_scope":
        raise RuntimeError("this key needs a higher scope") from exc
    raise
```

Every API error carries `status`, `code`, `details`, `issues` and the `request_id` to quote when
reporting a fault.

A `CatFactoryConnectionError` states what actually failed rather than asserting the deployment was
unreachable, and says what this client had already seen from the origin:

```text
cat-factory SDK: POST /api/v1/tasks failed: https://cat-factory.example.com reset the connection
before answering. This client had answered 9 calls against https://cat-factory.example.com, the
last 0.2s ago. (<urlopen error [Errno 104] Connection reset by peer>)
```

A reset after nine answered calls is a deployment that restarted; a refusal with nothing answered
yet is an address with nothing behind it, and the two send you to completely different places. The
runtime's own error is kept verbatim at the end of the message and as the raised exception's cause.

## Models

Frozen dataclasses with `from_dict` / `to_dict`. Two properties to know:

- **Unknown fields are kept**, on `extra`. `/api/v1` is additive forever, so a newer deployment
  sends fields this release has no attribute for; you can still reach them without upgrading.
- **Enums are `StrEnum`**, so a member IS its wire string (`task.status == "done"`, and an
  f-string renders `done`). An unrecognised value decodes to the plain string rather than raising.

## Local development and mocks

The base URL takes any origin (`http://localhost:8787`, a fixture server, a mock) and no scheme
validation is applied. Each client also accepts a custom transport, so you can intercept in-process
instead. See [the SDK guide](https://www.catfactory.ai/extend/sdks.html#pointing-a-client-at-localhost-or-a-mock).

## Notes

- `cat_factory/models.py` and `operations.py` are generated; see [`../README.md`](../README.md).
- API reference: [`backend/docs/public-api.md`](../../backend/docs/public-api.md).
