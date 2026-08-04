"""The Python SDK's smoketest program.

One of four programs — one per SDK — that drive the SAME scenario against a live deployment and
write the SAME observation report. The harness (``backend/internal/sdk-smoketest``) boots a real
backend, runs all four, and then compares their reports field by field.

That comparison is the point. A per-SDK test can only assert that ITS OWN client agrees with what
its author expected; four reports compared against each other catch the class of bug this SDK
family is most exposed to — one language decoding a field differently, mapping an error to the
wrong class, dropping a null, or paginating one page short — because those show up as a
DISAGREEMENT even when nobody wrote down what the right answer was.

So the rule for this file: OBSERVE and RECORD, do not assert.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cat_factory import (  # noqa: E402
    SDK_VERSION,
    CatFactoryClient,
    CatFactoryForbiddenError,
    CatFactoryNotFoundError,
    CatFactoryUnauthorizedError,
)
from cat_factory.models import (  # noqa: E402
    CreatePublicTask,
    NotificationWebhookRunEvent,
    PutNotificationWebhook,
    StartPublicTask,
    UpdatePublicTask,
)

TERMINAL_SSE_EVENTS = {"done", "error", "timeout"}
KNOWN_SSE_EVENTS = {"progress", "done", "error", "decision", "timeout"}
KNOWN_RUN_STATUSES = {"running", "blocked", "paused", "done", "failed"}


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"smoketest: {name} is required")
    return value


base_url = require_env("CAT_FACTORY_BASE_URL")
api_key = require_env("CAT_FACTORY_API_KEY")
read_key = require_env("CAT_FACTORY_READ_KEY")
out_path = require_env("CAT_FACTORY_SMOKETEST_OUT")

observations: dict[str, object] = {}
failures: list[str] = []


def step(name: str, fn: Callable[[], None]) -> None:
    """Run one scenario step, recording a failure rather than aborting the rest of the run."""
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 - a step's failure must not stop the others
        failures.append(f"{name}: {exc}")


client = CatFactoryClient(base_url=base_url, api_key=api_key, user_agent="cat-factory-smoketest")
read_client = CatFactoryClient(base_url=base_url, api_key=read_key)

state: dict[str, str] = {"service_id": "", "task_id": "", "pipeline_id": ""}


def list_services() -> None:
    result = client.services.list()
    observations["serviceCount"] = len(result.services)
    state["service_id"] = result.services[0].service_id if result.services else ""
    observations["firstServiceHasId"] = len(state["service_id"]) > 0


def list_pipelines() -> None:
    result = client.pipelines.list()
    observations["pipelineCount"] = len(result.pipelines)
    startable = [p for p in result.pipelines if p.headless_startable]
    observations["headlessStartableCount"] = len(startable)
    # `public` is a keyword in Java and Kotlin; reading it here keeps the four SDKs comparable on
    # the field whose NAME differs between them (`isPublic()` on the JVM).
    observations["publicPipelineCount"] = len([p for p in result.pipelines if p.public])
    state["pipeline_id"] = startable[0].pipeline_id if startable else ""


def create_task() -> None:
    task = client.tasks.create(
        state["service_id"],
        CreatePublicTask(
            title="SDK smoketest task",
            description="Created by the cross-SDK smoketest.",
            task_type="feature",
        ),
    )
    state["task_id"] = task.task_id
    observations["createdStatus"] = str(task.status)
    observations["createdTaskType"] = str(task.task_type)
    # A required-but-NULLABLE field: the server always sends it, and it is null here. Recording it
    # explicitly is what proves the four SDKs agree that "the server said null" and "the server
    # said nothing" are different facts.
    observations["createdRunIdIsNull"] = task.run_id is None
    observations["createdPullRequestUrlIsNull"] = task.pull_request_url is None


def update_task() -> None:
    task = client.tasks.update(state["task_id"], UpdatePublicTask(title="SDK smoketest task (edited)"))
    observations["updatedTitle"] = task.title


def get_task() -> None:
    task = client.tasks.get(state["task_id"])
    observations["fetchedTitle"] = task.title
    observations["fetchedStatus"] = str(task.status)


def list_one_page() -> None:
    page = client.tasks.list_by_service(state["service_id"], limit=1)
    observations["pageSize"] = len(page.tasks)
    observations["pageHasCursor"] = page.next_cursor is not None


def list_all_pages() -> None:
    seen = [task.task_id for task in client.tasks.list_by_service_all(state["service_id"], limit=1)]
    observations["pagedTaskCount"] = len(seen)
    observations["pagedContainsCreated"] = state["task_id"] in seen
    # A duplicate would mean the cursor was not advancing — the classic keyset paging bug, and one
    # a single-page test never sees.
    observations["pagedHasDuplicates"] = len(set(seen)) != len(seen)


def get_usage() -> None:
    usage = client.usage.get()
    observations["usageCurrency"] = usage.currency
    observations["usageBudgetExceeded"] = usage.budget.exceeded
    observations["usageRowsIsArray"] = isinstance(usage.rows, list)


def list_notifications() -> None:
    result = client.notifications.list()
    observations["notificationCount"] = len(result.notifications)


def round_trip_webhook() -> None:
    # The webhook round-trip is where the four clients are most exposed to a null decoding
    # differently: an unregistered endpoint is a ``webhook: null`` FIELD, and "the server said
    # null" must not arrive as an absence, an empty object, or a zero-valued struct in any
    # language.
    before = client.webhook.get()
    observations["webhookInitiallyNull"] = before.webhook is None
    saved = client.webhook.set(
        PutNotificationWebhook(
            url="https://hooks.example.com/cat-factory-smoketest",
            secret="smoketest-signing-secret",
            run_events=[NotificationWebhookRunEvent.RUN_COMPLETED],
        )
    )
    observations["webhookSavedUrl"] = saved.url
    # The secret is write-only: what comes back is the boolean, never the value.
    observations["webhookSavedHasSecret"] = saved.has_secret
    observations["webhookSavedRunEvents"] = ",".join(str(event) for event in saved.run_events)
    read = client.webhook.get()
    observations["webhookReadMatchesSaved"] = (
        read.webhook is not None and read.webhook.url == saved.url
    )
    client.webhook.delete()
    observations["webhookNullAfterDelete"] = client.webhook.get().webhook is None


def expect_not_found() -> None:
    try:
        client.tasks.get("blk_definitely_not_a_real_task")
        failures.append("error: not found — expected a 404, got a success")
    except CatFactoryNotFoundError as exc:
        observations["notFoundIsTypedClass"] = True
        observations["notFoundStatus"] = exc.status
        observations["notFoundCode"] = exc.code
        observations["notFoundHasRequestId"] = isinstance(exc.request_id, str)


def expect_unauthorized() -> None:
    bogus = CatFactoryClient(base_url=base_url, api_key="cf_live_pak_0000.deadbeef")
    try:
        bogus.services.list()
        failures.append("error: unauthorized — expected a 401, got a success")
    except CatFactoryUnauthorizedError as exc:
        observations["unauthorizedIsTypedClass"] = True
        observations["unauthorizedStatus"] = exc.status


def expect_insufficient_scope() -> None:
    try:
        # A `read` key may list, but never create. The refusal carries a SURFACE-specific code
        # (`insufficient_scope`) rather than a status-class one, which is exactly the case the
        # SDKs deliberately do not narrow to an enum — so all four must surface it verbatim.
        read_client.tasks.create(state["service_id"], CreatePublicTask(title="should be refused"))
        failures.append("error: insufficient scope — expected a 403, got a success")
    except CatFactoryForbiddenError as exc:
        observations["forbiddenIsTypedClass"] = True
        observations["forbiddenStatus"] = exc.status
        observations["forbiddenCode"] = exc.code


def start_task() -> None:
    body = StartPublicTask(pipeline_id=state["pipeline_id"] or None)
    task = client.tasks.start(state["task_id"], body)
    observations["startedStatus"] = str(task.status)
    observations["startedHasRunId"] = task.run_id is not None


def stream_task() -> None:
    events: list[str] = []
    with client.tasks.stream(state["task_id"]) as stream:
        for event in stream:
            events.append(event.event)
            # The run's own terminal frames, plus the deployment's connection cap. Stopping at a
            # fixed count as well keeps the smoketest bounded when a run parks on a human
            # decision — which is a legitimate outcome, not a failure.
            if event.event in TERMINAL_SSE_EVENTS or len(events) >= 3:
                break
    observations["sseEventCount"] = len(events)
    observations["sseFirstEvent"] = events[0] if events else None
    observations["sseFramesAreKnown"] = all(name in KNOWN_SSE_EVENTS for name in events)


def get_run() -> None:
    run = client.tasks.get_run(state["task_id"])
    observations["runHasSteps"] = len(run.steps) > 0
    observations["runStatusIsKnown"] = str(run.status) in KNOWN_RUN_STATUSES


def stop_task() -> None:
    task = client.tasks.stop(state["task_id"])
    observations["stoppedStatus"] = str(task.status)


def delete_task() -> None:
    client.tasks.delete(state["task_id"])
    try:
        client.tasks.get(state["task_id"])
        failures.append("tasks.delete — the task was still readable after deletion")
        observations["deletedThenGone"] = False
    except CatFactoryNotFoundError:
        observations["deletedThenGone"] = True


step("services.list", list_services)
step("pipelines.list", list_pipelines)
step("tasks.create", create_task)
step("tasks.update", update_task)
step("tasks.get", get_task)
step("tasks.listByService (one page)", list_one_page)
step("tasks.listByServiceAll (auto-paging)", list_all_pages)
step("usage.get", get_usage)
step("notifications.list", list_notifications)
step("webhook.get / set / delete", round_trip_webhook)
step("error: not found", expect_not_found)
step("error: unauthorized", expect_unauthorized)
step("error: insufficient scope", expect_insufficient_scope)
step("tasks.start", start_task)
step("tasks.stream (SSE)", stream_task)
step("tasks.getRun", get_run)
step("tasks.stop", stop_task)
step("tasks.delete", delete_task)

Path(out_path).write_text(
    json.dumps(
        {"sdk": "python", "sdkVersion": SDK_VERSION, "observations": observations, "failures": failures},
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)

if failures:
    print(f"python smoketest recorded {len(failures)} failure(s):", file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    raise SystemExit(1)
print("python smoketest completed")
