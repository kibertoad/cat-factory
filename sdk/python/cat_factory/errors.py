"""The SDK's exception hierarchy.

Every failure the API reports arrives as one envelope --- ``{"error": {"code", "message",
"details"?, "issues"?}}`` --- and the SDK turns it into a typed exception. Which class you get is
decided by the HTTP STATUS, never by ``code``.

That split is deliberate. ``/api/v1`` puts two families of value in ``error.code``: the
status-class codes (``validation``, ``not_found``, ``conflict``, ...) and codes specific to this
surface (``insufficient_scope``, ``invalid_cursor``, ``pipeline_not_public``,
``too_many_active_runs``, ...), and the surface is additive forever --- new codes appear without a
major version. So the status is the part that is safe to branch a CLASS on, and ``code`` is
exposed verbatim as a plain string for a caller to branch on precisely. Narrowing ``code`` to a
closed enum here would mean an SDK release is required before a caller could even NAME a refusal
the server already sends, and a copy of the vocabulary would be a second place for it to go stale.
The authoritative list is ``backend/docs/public-api.md``.
"""

from __future__ import annotations

from typing import Any


class CatFactoryError(Exception):
    """Base class for everything this SDK raises, so one ``except`` bounds the whole client."""


class CatFactoryConnectionError(CatFactoryError):
    """The request never produced an HTTP response: DNS, TCP, TLS, or a dropped socket."""


class CatFactoryTimeoutError(CatFactoryError):
    """The request exceeded the client-side deadline, so no verdict was reached."""


class CatFactoryDecodeError(CatFactoryError):
    """A 2xx response whose body was not the JSON the contract promises.

    In practice a proxy or gateway answering in the deployment's place. The raw text is kept on
    ``raw_body``, because "invalid JSON" on its own does not tell you that something in front of
    the backend returned an HTML error page.
    """

    def __init__(self, message: str, raw_body: str) -> None:
        super().__init__(message)
        self.raw_body = raw_body


class CatFactoryApiError(CatFactoryError):
    """The server answered, and the answer was a refusal.

    Subclasses name the status CLASS; :attr:`code` names the specific cause.
    """

    def __init__(
        self,
        *,
        status: int,
        code: str,
        message: str,
        details: Any = None,
        issues: list[dict[str, Any]] | None = None,
        request_id: str | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(f"{status} {code}: {message}")
        #: The HTTP status.
        self.status = status
        #: The machine-readable ``error.code`` --- see the module docstring.
        self.code = code
        #: Operator prose. Not localized, and not a stable identifier --- do not branch on it.
        self.api_message = message
        #: ``error.details``, whose shape depends on ``code``.
        self.details = details
        #: Per-field validation failures, when the server reported any.
        self.issues = issues or []
        #: The ``X-Request-Id`` of the failing call --- what correlates it with the deployment's
        #: own logs, and the id to quote when reporting a fault.
        self.request_id = request_id
        #: The raw body, for a failure whose ``details`` this SDK does not model.
        self.body = body


class CatFactoryValidationError(CatFactoryApiError):
    """400 / 422 --- the request was malformed, or a domain rule refused it."""


class CatFactoryUnauthorizedError(CatFactoryApiError):
    """401 --- no key, or a key that has been revoked."""


class CatFactoryForbiddenError(CatFactoryApiError):
    """403 --- a key whose scope is too low (``insufficient_scope``), or a forbidden action."""


class CatFactoryNotFoundError(CatFactoryApiError):
    """404 --- no such resource, or one outside this key's workspace (indistinguishable)."""


class CatFactoryConflictError(CatFactoryApiError):
    """409 --- the resource is not in a state that admits this action."""


class CatFactoryCredentialRequiredError(CatFactoryApiError):
    """428 --- a credential the action needs has not been supplied."""


class CatFactoryRateLimitedError(CatFactoryApiError):
    """429 --- rate limited, or a counted cap is already full (``too_many_active_runs``)."""


class CatFactoryServerError(CatFactoryApiError):
    """5xx --- the deployment faulted, or a dependency it needs is unavailable."""


_BY_STATUS: dict[int, type[CatFactoryApiError]] = {
    400: CatFactoryValidationError,
    401: CatFactoryUnauthorizedError,
    403: CatFactoryForbiddenError,
    404: CatFactoryNotFoundError,
    409: CatFactoryConflictError,
    422: CatFactoryValidationError,
    428: CatFactoryCredentialRequiredError,
    429: CatFactoryRateLimitedError,
}


def to_api_error(status: int, body: Any, request_id: str | None) -> CatFactoryApiError:
    """Build the typed error for a failed response.

    A body that is not the documented envelope (a proxy's HTML error page, a truncated stream)
    still yields a usable error: the status is always known, and the unparsed body is retained on
    ``body`` rather than discarded, so a caller diagnosing an unexpected failure is not left with
    "something went wrong".
    """
    envelope = body.get("error") if isinstance(body, dict) else None
    cls = _BY_STATUS.get(status) or (
        CatFactoryServerError if status >= 500 else CatFactoryApiError
    )
    return cls(
        status=status,
        code=(envelope or {}).get("code") or ("internal" if status >= 500 else "unknown"),
        message=(envelope or {}).get("message") or f"HTTP {status}",
        details=(envelope or {}).get("details"),
        issues=(envelope or {}).get("issues"),
        request_id=request_id,
        body=body,
    )
