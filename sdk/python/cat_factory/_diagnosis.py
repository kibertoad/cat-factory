"""What a transport failure actually was, and what the client already knows about the origin.

The problem this exists for: ``urllib`` reports a transport failure as ``URLError(reason)``, and
the SDK used to render every one of them as ``failed to reach <base_url>``. That sentence is a
verdict about REACHABILITY, and it is the one provably false reading when the deployment answered
nine calls two hundred milliseconds earlier and then restarted: it sends the reader to the boot
log, the database and the CORS config before the transport is ever suspected.

So the SDK says which cause it was, and drops the reachability claim when the cause does not
support it. The two facts needed for that are already here: the CAUSE hangs off the raised
exception's chain, and the HISTORY belongs to the client instance that made the earlier calls.

A PORT of the platform's own ``ConnectionFailureCause`` vocabulary, not an import of it: this SDK
declares no dependencies by design.

What keeps the copy honest is ``scripts/check-sdk-connection-causes.mjs``, a repo-level guard that
reads the contracts picklist and all four ported lists and fails on any disagreement. It has to be
a guard rather than a test in here: a test in this package cannot see the picklist, so it could
only restate the list a second time and would stay green through the exact drift that matters.
What each cause is MATCHED ON below is this runtime's own business, and is pinned by
``tests/test_diagnosis.py``.
"""

from __future__ import annotations

import errno
import socket
import ssl
from dataclasses import dataclass
from urllib.parse import urlsplit

#: Why a request never produced a response. ``unknown`` is a real member: an unrecognised failure
#: is reported as itself rather than guessed onto a cause, because a wrong cause is what sends a
#: reader to fix something that was never broken.
CAUSES = (
    "refused",
    "dns",
    "timeout",
    "aborted",
    "unreachable",
    "reset",
    "tls-untrusted",
    "tls-expired",
    "tls-hostname",
    "tls-protocol",
    "invalid-header",
    "unknown",
)

#: The errno values each cause is recognised by.
_CAUSE_ERRNOS: dict[str, tuple[int, ...]] = {
    "refused": (errno.ECONNREFUSED,),
    "timeout": (errno.ETIMEDOUT,),
    "unreachable": (errno.EHOSTUNREACH, errno.ENETUNREACH, errno.ENETDOWN, errno.EHOSTDOWN),
    "reset": (errno.ECONNRESET, errno.EPIPE),
}

#: OpenSSL's own reason strings, which is where the TLS distinctions actually live: the
#: certificate verification codes below say WHY a chain was rejected, and these say the handshake
#: never got that far.
_TLS_PROTOCOL_REASONS = frozenset(
    {
        "WRONG_VERSION_NUMBER",
        "UNKNOWN_PROTOCOL",
        "PACKET_LENGTH_TOO_LONG",
        "UNEXPECTED_MESSAGE",
        "UNSUPPORTED_PROTOCOL",
        "NO_PROTOCOLS_AVAILABLE",
        "TLSV1_ALERT_PROTOCOL_VERSION",
    }
)

#: X.509 verification codes, as OpenSSL numbers them. Split the way an operator's next action
#: splits: paste a CA bundle, renew a certificate, or correct the host name.
_VERIFY_UNTRUSTED = frozenset({18, 19, 20, 21, 24, 27})
_VERIFY_EXPIRED = frozenset({10, 9})
_VERIFY_HOSTNAME = frozenset({62})


@dataclass
class OriginHistory:
    """What this client has seen from the origin, which tells a restart from a bad address."""

    #: Requests that produced a RESPONSE, of any status: each one proves the origin answered.
    completed_calls: int = 0
    #: When the last of them answered (``time.monotonic()``), or None when none has.
    last_completed_at: float | None = None


def _chain(exc: BaseException) -> list[BaseException]:
    """The exception and everything under it, outermost first and bounded against a cycle."""
    links: list[BaseException] = []
    seen: set[int] = set()
    queue: list[object] = [exc]
    while queue and len(links) < 12:
        link = queue.pop(0)
        if not isinstance(link, BaseException) or id(link) in seen:
            continue
        seen.add(id(link))
        links.append(link)
        # ``URLError.reason`` is where urllib puts the real OSError, and it is neither
        # ``__cause__`` nor ``__context__``: reading only the dunder chain is how every DNS
        # failure and every refused connection rendered as the same contentless wrapper.
        queue.extend([getattr(link, "reason", None), link.__cause__, link.__context__])
    return links


def _classify_one(exc: BaseException) -> str | None:
    if isinstance(exc, ssl.SSLCertVerificationError):
        code = getattr(exc, "verify_code", None)
        if code in _VERIFY_HOSTNAME or "hostname mismatch" in str(exc).lower():
            return "tls-hostname"
        if code in _VERIFY_EXPIRED:
            return "tls-expired"
        if code in _VERIFY_UNTRUSTED:
            return "tls-untrusted"
        return "tls-untrusted"
    if isinstance(exc, ssl.SSLError):
        reason = getattr(exc, "reason", None)
        if reason in _TLS_PROTOCOL_REASONS:
            return "tls-protocol"
        if reason == "CERTIFICATE_VERIFY_FAILED":
            return "tls-untrusted"
        return "tls-protocol"
    if isinstance(exc, socket.gaierror):
        return "dns"
    if isinstance(exc, TimeoutError):
        return "timeout"
    number = getattr(exc, "errno", None)
    if isinstance(number, int):
        for cause, numbers in _CAUSE_ERRNOS.items():
            if number in numbers:
                return cause
    return None


def classify_transport_failure(exc: BaseException) -> str:
    """The cause of a whole chain, DEEPEST-FIRST.

    Depth is specificity order: a certificate rejection arrives wrapped in the generic URLError
    urllib raises, and answering with the wrapper is what sends an operator looking for a proxy
    instead of pasting a CA bundle. A text match runs only after every link failed to be
    recognised structurally, because a message is a guess where a type or an errno is a fact.
    """
    links = list(reversed(_chain(exc)))
    for link in links:
        recognised = _classify_one(link)
        if recognised is not None:
            return recognised
    for link in links:
        text = str(link).lower()
        if "invalid header" in text or "invalid character in header" in text:
            return "invalid-header"
    return "unknown"


def render_cause_chain(exc: BaseException) -> str:
    """The chain as the runtime reported it, deduplicated and leading with what it named."""
    parts: list[str] = []
    for link in _chain(exc):
        text = str(link).strip()
        if not text or text in parts:
            continue
        parts.append(text)
    meaningful = [part for part in parts if part not in ("<urlopen error >", "")]
    return ": ".join(meaningful or parts)


def _host_of(base_url: str) -> str:
    return urlsplit(base_url).netloc or base_url


def _verdict(cause: str, base_url: str) -> str:
    """What happened, stating only what the cause supports."""
    if cause == "refused":
        return f"nothing is listening at {base_url}"
    if cause == "dns":
        return f"the host {_host_of(base_url)} does not resolve from here"
    if cause == "timeout":
        return f"{base_url} did not answer before the connection timed out"
    if cause == "aborted":
        return (
            "the request was cancelled before an answer arrived, so nothing was learned about "
            f"{base_url}"
        )
    if cause == "unreachable":
        return f"there is no network route to {base_url} from here"
    if cause == "reset":
        return f"{base_url} reset the connection before answering"
    if cause == "tls-untrusted":
        return f"{base_url} presented a TLS certificate this client does not trust"
    if cause == "tls-expired":
        return f"the TLS certificate {base_url} presented is outside its validity window"
    if cause == "tls-hostname":
        return (
            f"the TLS certificate {base_url} presented was not issued for {_host_of(base_url)}"
        )
    if cause == "tls-protocol":
        return (
            f"the TLS handshake with {base_url} failed, which is what a plain-HTTP port answers "
            "when it is addressed over https"
        )
    if cause == "invalid-header":
        return (
            "the request could not be built, because a header value holds a character that is "
            "not allowed in one"
        )
    return f"the request to {base_url} ended before any response arrived"


def _render_age(seconds: float) -> str:
    """``0.2s``, ``12s``, ``4m``: precise where a restart is told from a long-dead origin."""
    seconds = max(0.0, seconds)
    if seconds < 60:
        return f"{seconds:.1f}s" if seconds < 10 else f"{round(seconds)}s"
    return f"{round(seconds / 60)}m"


def _history(history: OriginHistory, base_url: str, now: float) -> str:
    """Stated in both directions: "answered nothing yet" points at the address, not the origin."""
    if history.completed_calls == 0 or history.last_completed_at is None:
        return f" This client has not completed a call against {base_url} yet."
    calls = "1 call" if history.completed_calls == 1 else f"{history.completed_calls} calls"
    age = _render_age(now - history.last_completed_at)
    return f" This client had answered {calls} against {base_url}, the last {age} ago."


def describe_transport_failure(
    *,
    method: str,
    path: str,
    base_url: str,
    exc: BaseException,
    history: OriginHistory,
    now: float,
) -> str:
    """What happened, what this client knows about the origin, then the exact chain, in that order.

    The chain stays LAST and stays verbatim: it is the evidence, and a reader who disagrees with
    the classification needs it unedited.
    """
    detail = render_cause_chain(exc)
    evidence = f" ({detail})" if detail else ""
    verdict = _verdict(classify_transport_failure(exc), base_url)
    return (
        f"cat-factory SDK: {method} {path} failed: {verdict}."
        f"{_history(history, base_url, now)}{evidence}"
    )
