"""The SSE reader's framing rules.

The cross-SDK smoketest proves the stream works end to end, but it cannot provoke the cases that
actually bite — a read boundary landing mid-record, a multi-line payload, a terminal frame arriving
in the same breath as the socket closing. Each of those shows up in production as a run that
silently appears to stall, so each gets a test that constructs the byte sequence directly.

The other SDKs have mirrors of this file. The four readers are independent implementations of one
wire format, so they need independent tests — the smoketest compares what they observed, not how
they framed it.
"""

from __future__ import annotations

import io

from cat_factory._sse import EventStream, StreamEvent


class ClosingBytes(io.BytesIO):
    """A body that records whether it was released."""

    closed_by_sdk = False

    def close(self) -> None:
        self.closed_by_sdk = True
        super().close()


def collect(body: str) -> list[StreamEvent]:
    return list(EventStream(io.BytesIO(body.encode("utf-8"))))


def names(events: list[StreamEvent]) -> list[str]:
    return [event.event for event in events]


def test_decodes_a_record() -> None:
    events = collect('event: progress\ndata: {"runId":"r1"}\n\n')
    assert len(events) == 1
    assert events[0].event == "progress"
    assert events[0].json() == {"runId": "r1"}


def test_joins_data_lines() -> None:
    # Per the SSE spec. Taking only the last line would silently truncate a payload.
    events = collect("event: progress\ndata: line one\ndata: line two\n\n")
    assert events[0].data == "line one\nline two"


def test_yields_unterminated_trailing_record() -> None:
    # The case that matters: a server closing the connection in the same breath as its terminal
    # frame. Dropping the unterminated record loses exactly the `done` the caller waits for.
    events = collect('event: progress\ndata: {}\n\nevent: done\ndata: {"ok":true}\n')
    assert names(events) == ["progress", "done"]
    assert events[1].json() == {"ok": True}


def test_ignores_keep_alives() -> None:
    # Servers send `:` lines to hold the connection open. Treating one as a record would hand the
    # caller a phantom event on a perfectly healthy stream.
    assert names(collect(": keep-alive\n\nevent: done\ndata: {}\n\n")) == ["done"]


def test_accepts_crlf() -> None:
    # A proxy that normalizes line endings would otherwise make the stream appear to emit nothing
    # at all, because no complete record would ever be recognised.
    events = collect('event: progress\r\ndata: {"a":1}\r\n\r\n')
    assert len(events) == 1
    assert events[0].json() == {"a": 1}


def test_strips_one_leading_space() -> None:
    # The single space is framing; a second one is payload.
    assert collect("event: progress\ndata:  padded\n\n")[0].data == " padded"


def test_defaults_event_name() -> None:
    assert collect('data: {"a":1}\n\n')[0].event == "message"


def test_json_returns_none_for_non_json() -> None:
    # Returning None rather than raising: a non-JSON frame mid-stream is normal, and a client that
    # raised on one would fail on a healthy connection.
    assert collect("event: progress\ndata: not json\n\n")[0].json() is None


def test_records_split_across_reads() -> None:
    # The reader pulls 1 KiB at a time, so a record longer than that spans reads. A reader that
    # decoded per read would emit broken records here, or none.
    payload = "x" * 4096
    events = collect(f"event: progress\ndata: {payload}\n\n")
    assert len(events) == 1
    assert events[0].data == payload


def test_close_releases_the_body() -> None:
    body = ClosingBytes(b"event: progress\ndata: {}\n\n")
    with EventStream(body) as stream:
        for _event in stream:
            break
    assert body.closed_by_sdk, "the SDK must release the socket rather than hold it open"
