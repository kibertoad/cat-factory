"""``cat-factory-sdk`` --- the Python client for the cat-factory public API (``/api/v1``).

The models and the 38 operation methods are GENERATED from ``docs/openapi.json`` (itself
generated from the Valibot route contracts), so they cannot drift from the deployment they talk
to. The transport, errors and SSE framing are hand-written.

The SDK has NO third-party dependencies: it is built on ``urllib`` from the standard library, so
installing it cannot conflict with whatever HTTP stack the consuming application already uses.
"""

from ._http import SDK_VERSION, Transport
from ._sse import EventStream, StreamEvent
from .client import CatFactoryClient
from .errors import (
    CatFactoryApiError,
    CatFactoryConflictError,
    CatFactoryConnectionError,
    CatFactoryCredentialRequiredError,
    CatFactoryDecodeError,
    CatFactoryError,
    CatFactoryForbiddenError,
    CatFactoryNotFoundError,
    CatFactoryRateLimitedError,
    CatFactoryServerError,
    CatFactoryTimeoutError,
    CatFactoryUnauthorizedError,
    CatFactoryValidationError,
)

__version__ = SDK_VERSION

__all__ = [
    "SDK_VERSION",
    "CatFactoryApiError",
    "CatFactoryClient",
    "CatFactoryConflictError",
    "CatFactoryConnectionError",
    "CatFactoryCredentialRequiredError",
    "CatFactoryDecodeError",
    "CatFactoryError",
    "CatFactoryForbiddenError",
    "CatFactoryNotFoundError",
    "CatFactoryRateLimitedError",
    "CatFactoryServerError",
    "CatFactoryTimeoutError",
    "CatFactoryUnauthorizedError",
    "CatFactoryValidationError",
    "EventStream",
    "StreamEvent",
    "Transport",
    "__version__",
]
