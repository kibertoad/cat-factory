"""The client a caller constructs: a transport plus the generated resource clients on it."""

from __future__ import annotations

import urllib.request
from collections.abc import Mapping
from typing import TYPE_CHECKING

from ._http import Transport
from .operations import build_resources

if TYPE_CHECKING:  # pragma: no cover - import cycle only matters to a type checker
    from .operations import (
        DebugResource,
        DecisionsResource,
        JobsResource,
        NotificationsResource,
        PipelinesResource,
        ServicesResource,
        TasksResource,
        TaskTypesResource,
        UsageResource,
        WebhookResource,
    )


class CatFactoryClient:
    """A cat-factory public-API client.

    ::

        from cat_factory import CatFactoryClient

        client = CatFactoryClient(
            base_url="https://cat-factory.example.com",
            api_key=os.environ["CAT_FACTORY_API_KEY"],
        )
        services = client.services.list().services
        task = client.tasks.create(services[0].service_id, CreatePublicTask(title="Add a health check"))
        client.tasks.start(task.task_id, StartPublicTask())

    Every call is scoped to the key's workspace, and each resource attribute mirrors one tag of
    the published OpenAPI surface. The client is stateless beyond its configuration, so one
    instance is safe to share across threads.

    ``base_url`` may point anywhere, including a local mock or a recorded fixture server
    (``base_url="http://localhost:8080"``): no scheme validation is applied, and ``opener`` takes
    a custom transport if you would rather intercept in-process.
    """

    # Declared for type checkers only; the attributes themselves are ASSIGNED from the generated
    # resource table below rather than constructed here. Listing them by hand would be a second
    # copy of the surface table that nothing keeps in sync --- a group added to the generator
    # would import, run, and simply not be reachable from the client anyone constructs.
    if TYPE_CHECKING:
        jobs: JobsResource
        services: ServicesResource
        tasks: TasksResource
        pipelines: PipelinesResource
        task_types: TaskTypesResource
        notifications: NotificationsResource
        webhook: WebhookResource
        usage: UsageResource
        decisions: DecisionsResource
        debug: DebugResource

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
        max_retries: int = 2,
        headers: Mapping[str, str] | None = None,
        user_agent: str | None = None,
        opener: urllib.request.OpenerDirector | None = None,
    ) -> None:
        """Build a client.

        :param base_url: the deployment's origin, e.g. ``https://cat-factory.example.com``.
        :param api_key: a public-API key of the form ``cf_live_<keyId>.<secret>``.
        :param timeout: per-request deadline in seconds.
        :param max_retries: retries for a RETRIABLE failure. A non-idempotent request is never
            retried automatically, so raising this does not make ``jobs.create`` replayable.
        :param headers: headers sent on every request.
        :param user_agent: prefixed to ``User-Agent`` so a deployment's logs can attribute calls
            to your integration.
        :param opener: a custom ``urllib`` opener — a proxy handler, a client certificate, or a
            test double. The sibling SDKs each take the same escape hatch (TypeScript ``fetch``,
            Go ``HTTPClient``, Java ``httpClient``); without it, Python would be the one client
            you could not point at your own transport.
        """
        self._transport = Transport(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            max_retries=max_retries,
            headers=headers,
            user_agent=user_agent,
            opener=opener,
        )
        for name, resource in build_resources(self._transport).items():
            setattr(self, name, resource)

    def set_personal_password(self, password: str | None) -> None:
        """Supply the personal password for a key BOUND to a user.

        It unlocks that user's own model subscription for the runs this client starts, retries and
        answers parks on, riding every subsequent request as ``X-Personal-Password``. The
        deployment never stores it.

        Settable after construction because that is when a caller learns it is needed: an operation
        answers ``428 credential_required``, the caller prompts (or reads its secret store), and
        retries. Passing it to ``__init__`` would mean discarding a configured client to send one
        header.
        """
        self._transport.personal_password = password
