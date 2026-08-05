"""The transport: the one place that knows about auth, retries, timeouts and error mapping.

Built on ``urllib`` from the standard library rather than ``requests`` or ``httpx``. A client
library's dependencies become every consumer's dependencies, and a transitive HTTP stack is the
single most common source of version conflicts in a Python application --- so this SDK installs
with none. A caller who wants connection pooling or HTTP/2 supplies their own opener through
``transport_factory`` rather than being forced into ours.
"""

from __future__ import annotations

import datetime
import email.utils
import json
import random
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import urlencode

from ._sse import EventStream
from .errors import (
    CatFactoryConnectionError,
    CatFactoryDecodeError,
    CatFactoryError,
    CatFactoryTimeoutError,
    to_api_error,
)

#: SDK version, stamped into ``User-Agent``. Kept in step with pyproject.toml by ``check:sdk``.
SDK_VERSION = "0.4.0"

#: Methods that may be replayed after a failure.
#:
#: A transport failure with no response tells us nothing about whether the server acted, so only
#: a method that is idempotent BY DEFINITION is replayed. ``POST /jobs`` and
#: ``POST /tasks/:id/start`` both cost real LLM work, and a duplicate is not something the SDK
#: may decide to risk on the caller's behalf.
_IDEMPOTENT = frozenset({"GET", "HEAD", "DELETE"})

#: Statuses worth a second attempt when the method allows it.
_RETRIABLE_STATUS = frozenset({429, 502, 503, 504})


def _backoff_seconds(attempt: int) -> float:
    """Full jitter on an exponential base, so a fleet of clients does not retry in lockstep."""
    return random.random() * min(8.0, 0.25 * (2**attempt))


class Transport:
    """Performs requests against a deployment, applying auth, deadlines and the retry policy."""

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
        if not base_url:
            raise ValueError("cat-factory SDK: base_url is required.")
        if not api_key:
            raise ValueError("cat-factory SDK: api_key is required.")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        agent = f"{user_agent} " if user_agent else ""
        self._headers = {
            "accept": "application/json",
            "user-agent": f"{agent}cat-factory-sdk-python/{SDK_VERSION}",
            **dict(headers or {}),
        }
        self._opener = opener or urllib.request.build_opener()

    # -- public surface the generated operations call ------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """Perform a request and return the decoded JSON body."""
        raw = self._send(method, path, body, query, timeout, "application/json")
        text = raw.decode("utf-8")
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise CatFactoryDecodeError(
                f"cat-factory SDK: {method} {path} returned a body that is not JSON.", text
            ) from exc

    def request_no_content(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> None:
        """Perform a request whose success carries no body (a 204)."""
        self._send(method, path, body, query, timeout, "application/json")

    def request_bytes(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> bytes:
        """Perform a request whose success carries BYTES rather than JSON.

        Returned whole rather than as a file object: the listing endpoint that hands out these
        ids also carries each artifact's exact ``byteSize``, so a caller decides whether to fetch
        BEFORE issuing the request, and every artifact is bounded by the platform's own upload
        ceiling.

        ``*/*``, because the endpoint declares SEVERAL media types (the image allow-list plus an
        octet-stream fallback) and answers with whichever one the stored artifact is; naming any
        single one would disagree with most of what it sends.
        """
        return self._send(method, path, body, query, timeout, "*/*")

    def stream(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> EventStream:
        """Open a server-sent event stream.

        Deliberately NOT retried: a reconnect would replay the stream from its start, and the
        caller --- who knows which events it has already acted on --- is the only party that can
        decide whether that is safe.
        """
        request = self._build(method, path, body, query, "text/event-stream")
        try:
            # No `with`: the response IS the stream, and closing it here would close the socket
            # the caller is about to read from. `EventStream.close()` owns it from now on.
            raw = self._opener.open(request, timeout=timeout or self._timeout)
        except urllib.error.HTTPError as exc:
            raise self._from_http_error(exc) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise self._from_transport_error(exc, method, path) from exc
        _release_read_deadline(raw)
        return EventStream(raw)

    # -- internals -----------------------------------------------------------------------------

    def _url(self, path: str, query: Mapping[str, Any] | None) -> str:
        # Drop absent values so `?limit=None` is impossible.
        pairs = [(k, v) for k, v in (query or {}).items() if v is not None]
        rendered = urlencode([(k, _wire(v)) for k, v in pairs])
        return f"{self._base_url}{path}{'?' + rendered if rendered else ''}"

    def _build(
        self,
        method: str,
        path: str,
        body: Any,
        query: Mapping[str, Any] | None,
        accept: str,
    ) -> urllib.request.Request:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self._url(path, query), data=payload, method=method)
        for key, value in self._headers.items():
            request.add_header(key, value)
        request.add_header("accept", accept)
        request.add_header("authorization", f"Bearer {self._api_key}")
        if payload is not None:
            request.add_header("content-type", "application/json")
        return request

    def _send(
        self,
        method: str,
        path: str,
        body: Any,
        query: Mapping[str, Any] | None,
        timeout: float | None,
        accept: str,
    ) -> bytes:
        budget = self._max_retries
        deadline = timeout if timeout is not None else self._timeout

        for attempt in range(budget + 1):
            request = self._build(method, path, body, query, accept)
            try:
                with self._opener.open(request, timeout=deadline) as response:
                    return response.read()
            except urllib.error.HTTPError as exc:
                retriable = method in _IDEMPOTENT and exc.code in _RETRIABLE_STATUS
                if attempt < budget and retriable:
                    # Honour `Retry-After` when the server states one: it is the deployment's own
                    # knowledge of when the limit clears, which beats a blind backoff curve.
                    time.sleep(_retry_after(exc) or _backoff_seconds(attempt))
                    continue
                raise self._from_http_error(exc) from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt < budget and method in _IDEMPOTENT:
                    time.sleep(_backoff_seconds(attempt))
                    continue
                raise self._from_transport_error(exc, method, path) from exc
        raise AssertionError("unreachable: the retry loop always returns or raises")

    def _from_http_error(self, exc: urllib.error.HTTPError) -> CatFactoryError:
        raw = exc.read()
        try:
            parsed: Any = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = raw.decode("utf-8", errors="replace")
        return to_api_error(exc.code, parsed, exc.headers.get("x-request-id"))

    def _from_transport_error(self, exc: Exception, method: str, path: str) -> CatFactoryError:
        # A timeout and a connection failure need DIFFERENT reactions --- one may succeed with a
        # longer budget, the other will not --- so they stay apart rather than collapsing into
        # one "request failed".
        if isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError):
            return CatFactoryTimeoutError(
                f"cat-factory SDK: {method} {path} exceeded its deadline."
            )
        return CatFactoryConnectionError(
            f"cat-factory SDK: {method} {path} failed to reach {self._base_url} ({exc})."
        )


def _release_read_deadline(raw: Any) -> None:
    """Stop the client deadline once a STREAM's response headers are in.

    ``urlopen(timeout=...)`` sets a SOCKET timeout, which keeps applying to every subsequent read
    --- so on a stream it silently becomes an inactivity limit rather than a request deadline. The
    deployment writes an SSE frame only when the run's projection CHANGES and sends no heartbeat,
    and a parked run waits for a human indefinitely by design, so a quiet stream is the normal
    state of a healthy one: left in place, the deadline aborts exactly the runs a caller most
    wants to watch.

    So the deadline covers the wait for HEADERS and nothing after it, which is what the other
    three SDKs already mean by it (TypeScript clears its abort timer once fetch resolves, Go stops
    the stream's timer at the same point, and the JDK's ``HttpRequest.timeout`` is defined that
    way). A stream is instead bounded by the caller closing it --- and, above it, by the
    deployment's own connection cap.

    urllib exposes no public way to do this, so the socket is reached through the attribute chain
    CPython actually builds (``HTTPResponse.fp`` -> ``BufferedReader.raw`` -> ``SocketIO._sock``).
    A response that does not have that shape --- a caller-supplied opener, a future CPython ---
    keeps its socket timeout: batching or an inactivity bound is a far smaller harm than reaching
    into an object we did not recognise.
    """
    socket = getattr(getattr(getattr(raw, "fp", None), "raw", None), "_sock", None)
    settimeout = getattr(socket, "settimeout", None)
    if settimeout is not None:
        settimeout(None)


def _wire(value: Any) -> str:
    """Render a query value the way the server reads it (``true``, not Python's ``True``)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(getattr(value, "value", value))


def _retry_after(exc: urllib.error.HTTPError) -> float | None:
    """``Retry-After`` in seconds, capped, or None when absent or unparsable.

    Both wire forms, because RFC 9110 allows either and a deployment behind a proxy or CDN
    routinely gets the HTTP-date one written for it. Reading only the numeric form silently
    discarded the deployment's own knowledge of when the limit clears and fell back to a blind
    backoff curve --- which still works, just worse, so nothing would ever have surfaced it.
    """
    header = exc.headers.get("retry-after")
    if not header:
        return None
    try:
        return max(0.0, min(float(header), 60.0))
    except ValueError:
        pass
    parsed = email.utils.parsedate_to_datetime(header.strip())
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        # An HTTP-date is GMT by definition; a naive one has simply lost the marker.
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    delta = (parsed - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
    return max(0.0, min(delta, 60.0))


#: The type of a caller-supplied opener factory, for a consumer that wants their own HTTP stack.
TransportFactory = Callable[..., Transport]
