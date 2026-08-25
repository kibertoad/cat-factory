"""The transport's connection DIAGNOSIS: which cause a chain names, and what history adds to it.

Unreachable from the cross-SDK smoketest, which drives a healthy deployment over a real socket,
and silent when wrong: the call still raises the class a caller catches, carrying a sentence that
sends them to the wrong place. A reset and a refusal are the pair that matters, because they take
opposite investigations (a deployment that is there and restarted, versus an address with nothing
behind it) and the SDK used to render both as ``failed to reach <base_url>``.
"""

from __future__ import annotations

import errno
import socket
import ssl
import urllib.error

from cat_factory._diagnosis import (
    CAUSES,
    OriginHistory,
    _verdict,
    classify_transport_failure,
    describe_transport_failure,
)


def _wrapped(reason: BaseException) -> urllib.error.URLError:
    """What urllib actually raises: a wrapper whose ``reason`` holds the real failure."""
    return urllib.error.URLError(reason)


def _describe(exc: BaseException, history: OriginHistory | None = None) -> str:
    return describe_transport_failure(
        method="POST",
        path="/api/v1/tasks",
        base_url="https://cat.example.test",
        exc=exc,
        history=history or OriginHistory(),
        now=1000.0,
    )


def test_reads_through_url_error_reason() -> None:
    # ``URLError.reason`` is neither ``__cause__`` nor ``__context__``, so a walk that reads only
    # the dunder chain renders every one of these as the same contentless wrapper.
    refused = OSError(errno.ECONNREFUSED, "Connection refused")
    assert classify_transport_failure(_wrapped(refused)) == "refused"
    dns = socket.gaierror(-2, "Name or service not known")
    assert classify_transport_failure(_wrapped(dns)) == "dns"
    reset = OSError(errno.ECONNRESET, "Connection reset by peer")
    assert classify_transport_failure(_wrapped(reset)) == "reset"


def test_separates_the_tls_failures_by_what_fixes_them() -> None:
    untrusted = ssl.SSLCertVerificationError("certificate verify failed: self signed certificate")
    untrusted.verify_code = 18
    assert classify_transport_failure(_wrapped(untrusted)) == "tls-untrusted"

    expired = ssl.SSLCertVerificationError("certificate verify failed: certificate has expired")
    expired.verify_code = 10
    assert classify_transport_failure(_wrapped(expired)) == "tls-expired"

    protocol = ssl.SSLError(1, "[SSL: WRONG_VERSION_NUMBER] wrong version number")
    protocol.reason = "WRONG_VERSION_NUMBER"
    assert classify_transport_failure(_wrapped(protocol)) == "tls-protocol"


def test_answers_unknown_rather_than_guessing() -> None:
    assert classify_transport_failure(_wrapped(OSError("something else entirely"))) == "unknown"


def test_renders_a_reset_and_a_refusal_differently() -> None:
    reset = _describe(
        _wrapped(OSError(errno.ECONNRESET, "Connection reset by peer")),
        OriginHistory(completed_calls=9, last_completed_at=999.8),
    )
    assert "reset the connection before answering" in reset
    assert "had answered 9 calls" in reset
    assert "the last 0.2s ago" in reset
    assert "Connection reset by peer" in reset
    assert "failed to reach" not in reset

    refused = _describe(_wrapped(OSError(errno.ECONNREFUSED, "Connection refused")))
    assert "nothing is listening at https://cat.example.test" in refused
    assert "has not completed a call against https://cat.example.test yet" in refused


def test_claims_nothing_about_the_origin_when_the_request_never_left() -> None:
    built = _describe(ValueError("Invalid header value b'key\\nwith-a-newline'"))
    assert "a header value holds a character that is not allowed in one" in built
    assert "nothing is listening" not in built


def test_every_cause_renders_its_own_sentence() -> None:
    """``CAUSES`` is the declared vocabulary, and this is what makes it load-bearing.

    ``_verdict`` is an ``if`` chain ending in the ``unknown`` sentence, so Python (unlike the
    TypeScript union and the Java enum, both of which the compiler checks) cannot tell that a
    member has no branch. A cause added without one would render "ended before any response
    arrived": a verdict claiming nothing was learned about the origin, for a failure the client
    had in fact recognised. That is the degrade-quietly failure the whole module exists to remove,
    reappearing one level up.

    Distinctness is the assertion rather than non-emptiness, because a member that fell through
    would produce a sentence that IS non-empty: the ``unknown`` one.
    """
    verdicts = {cause: _verdict(cause, "https://cat.example.test") for cause in CAUSES}
    assert set(verdicts) == set(CAUSES)
    assert all(verdicts.values()), "every cause owes a sentence"
    assert len(set(verdicts.values())) == len(CAUSES), (
        "two causes render the same sentence, which means one of them has no branch of its own "
        f"and fell through to the `unknown` verdict: {sorted(verdicts.items())}"
    )


def test_a_header_value_rejected_before_the_socket_is_named_as_one() -> None:
    """The cause that had no producer until the transport learned to catch a ``ValueError``.

    ``http.client`` rejects a header value carrying a control character with a bare ``ValueError``,
    which is neither an ``OSError`` nor a ``URLError``: it used to escape the transport uncaught.
    """
    rejected = ValueError("Invalid header value b'Bearer cf_live_pak_0000.a\\nb'")
    assert classify_transport_failure(rejected) == "invalid-header"
    assert "not allowed in one" in _describe(rejected)
