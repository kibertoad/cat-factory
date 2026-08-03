"""The server-sent-events reader for the two streaming endpoints.

Written by hand rather than leaned on a dependency for one reason: the framing rules that matter
here are the ones a naive ``split("\\n\\n")`` gets wrong, and getting them wrong shows up as a run
that silently appears to stall.

- A chunk boundary can fall ANYWHERE, including inside a ``data:`` line, so bytes accumulate in a
  buffer and only a COMPLETE record (terminated by a blank line) is dispatched.
- A record may carry several ``data:`` lines; per the spec they join with ``\\n``. Taking only the
  last would silently truncate a multi-line run projection.
- The stream ends in one of three ways the caller must tell apart: a terminal ``done``/``error``
  event, a ``timeout`` event when the deployment's connection cap is reached, or the socket simply
  closing. Only the first is the run reaching a verdict.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import IO, Any


@dataclass(frozen=True, slots=True)
class StreamEvent:
    """One decoded SSE record."""

    #: The ``event:`` field, or ``message`` when the server sent none (the SSE default).
    event: str
    #: The joined ``data:`` payload, verbatim.
    data: str
    #: The ``id:`` field, when present.
    id: str | None = None

    def json(self) -> Any | None:
        """``data`` parsed as JSON, or None when it is not JSON (e.g. a bare keep-alive)."""
        try:
            return json.loads(self.data)
        except json.JSONDecodeError:
            return None


def _decode(raw: str) -> StreamEvent | None:
    event = "message"
    identifier: str | None = None
    data: list[str] = []
    for line in raw.split("\n"):
        # A leading colon is a comment --- servers send them as keep-alives. Never a record.
        if line.startswith(":"):
            continue
        field, _, rest = line.partition(":")
        # One optional leading space after the colon is part of the framing, not the value.
        value = rest[1:] if rest.startswith(" ") else rest
        if field == "event":
            event = value
        elif field == "data":
            data.append(value)
        elif field == "id":
            identifier = value
    if not data and event == "message":
        return None
    return StreamEvent(event=event, data="\n".join(data), id=identifier)


class EventStream:
    """An iterable stream of :class:`StreamEvent`.

    Use it as a context manager (or call :meth:`close`) so the underlying socket is released
    rather than held open against the deployment's per-connection cap::

        with client.tasks.stream(task_id) as stream:
            for event in stream:
                if event.event in ("done", "error"):
                    break
    """

    def __init__(self, raw: IO[bytes]) -> None:
        self._raw = raw
        self._closed = False

    def __enter__(self) -> EventStream:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def __iter__(self):
        buffer = ""
        try:
            for chunk in iter(lambda: self._raw.read(1024), b""):
                buffer += chunk.decode("utf-8", errors="replace")
                # `\r\n\r\n` as well as `\n\n`: the spec allows either terminator, and a server
                # behind a proxy that normalizes line endings would otherwise never appear to
                # emit a complete record at all.
                buffer = buffer.replace("\r\n", "\n")
                while "\n\n" in buffer:
                    raw, _, buffer = buffer.partition("\n\n")
                    decoded = _decode(raw)
                    if decoded is not None:
                        yield decoded
            # A record left unterminated when the socket closed is still a record the server
            # sent. Dropping it would lose exactly the terminal `done` frame in the case where
            # the server closes the connection in the same breath as emitting it.
            trailing = _decode(buffer.strip())
            if trailing is not None:
                yield trailing
        finally:
            self.close()

    def close(self) -> None:
        """Release the socket. Safe to call more than once."""
        if self._closed:
            return
        self._closed = True
        try:
            self._raw.close()
        except OSError:
            # The socket is already gone --- that is the state we were trying to reach.
            pass
