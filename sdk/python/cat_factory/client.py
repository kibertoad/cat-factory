"""The client a caller constructs: a transport plus the generated resource clients on it."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from ._http import Transport
from .operations import build_resources

if TYPE_CHECKING:  # pragma: no cover - import cycle only matters to a type checker
    from .operations import (
        DebugResource,
        DecisionsResource,
        InitiativesResource,
        NotificationsResource,
        PipelinesResource,
        ServicesResource,
        TasksResource,
        UsageResource,
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
    """

    # Declared for type checkers only; the attributes themselves are ASSIGNED from the generated
    # resource table below rather than constructed here. Listing them by hand would be a second
    # copy of the surface table that nothing keeps in sync --- a group added to the generator
    # would import, run, and simply not be reachable from the client anyone constructs.
    if TYPE_CHECKING:
        initiatives: InitiativesResource
        services: ServicesResource
        tasks: TasksResource
        pipelines: PipelinesResource
        notifications: NotificationsResource
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
    ) -> None:
        """Build a client.

        :param base_url: the deployment's origin, e.g. ``https://cat-factory.example.com``.
        :param api_key: a public-API key of the form ``cf_live_<keyId>.<secret>``.
        :param timeout: per-request deadline in seconds.
        :param max_retries: retries for a RETRIABLE failure. A non-idempotent request is never
            retried automatically, so raising this does not make ``initiatives.create`` replayable.
        :param headers: headers sent on every request.
        :param user_agent: prefixed to ``User-Agent`` so a deployment's logs can attribute calls
            to your integration.
        """
        self._transport = Transport(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            max_retries=max_retries,
            headers=headers,
            user_agent=user_agent,
        )
        for name, resource in build_resources(self._transport).items():
            setattr(self, name, resource)
