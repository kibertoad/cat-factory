"""When a stream's frames reach the caller, and what the client deadline bounds.

Framing is covered in ``test_sse.py`` against synthetic buffers. These two properties cannot be:
both are about TIMING over a real socket, and both are invisible to the cross-SDK smoketest, whose
scenario finishes fast enough that every frame arrives either way. A report of what an SDK
OBSERVED cannot see that it observed all of it several minutes late, or that a longer run would
have been cut off partway.

Each failure mode shows up in production the same way — a run that appears to stall — which is why
they are pinned here in wall-clock against a server that actually trickles.
"""

from __future__ import annotations

import http.server
import socketserver
import threading
import time
from collections.abc import Iterator

import pytest

from cat_factory._http import Transport

FRAME_GAP = 0.15
FRAMES = 4


class _Trickle(http.server.BaseHTTPRequestHandler):
    """An SSE endpoint that emits slowly, and (on /quiet) goes silent mid-stream.

    The silence is the realistic case, not a contrived one: the deployment writes a frame only
    when the run's projection changes and sends no heartbeat, so a parked or long-running step
    produces exactly this.
    """

    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        quiet = self.path.startswith("/quiet")
        for index in range(FRAMES):
            if quiet and index == 1:
                # Longer than the client deadline the test configures: a healthy but quiet run.
                time.sleep(0.6)
            frame = f'event: progress\ndata: {{"n":{index}}}\n\n'.encode()
            self.wfile.write(b"%x\r\n" % len(frame) + frame + b"\r\n")
            self.wfile.flush()
            time.sleep(FRAME_GAP)
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def log_message(self, *_args: object) -> None:
        """Silence the default stderr access log."""


@pytest.fixture()
def server() -> Iterator[str]:
    httpd = socketserver.TCPServer(("127.0.0.1", 0), _Trickle)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_frames_arrive_as_they_are_sent(server: str) -> None:
    """A frame must reach the caller when it is SENT, not when the stream ends.

    `read(n)` on urllib's HTTPResponse blocks until it has n bytes, so a 1 KiB read used to hold
    every frame of a slow run until the socket closed and then deliver them in one lump. The
    assertion is therefore about elapsed time at the FIRST frame, not about the set of frames:
    the old code passed any test that only checked what came out.
    """
    transport = Transport(base_url=server, api_key="k", timeout=5.0)
    started = time.monotonic()
    with transport.stream("GET", "/events") as stream:
        arrivals = [time.monotonic() - started for _ in stream]

    assert len(arrivals) == FRAMES
    # The whole stream spans FRAMES * FRAME_GAP; a batched reader delivers the first frame only at
    # the end of that. Half of one gap's slack absorbs scheduling noise.
    assert arrivals[0] < FRAME_GAP * 1.5, (
        f"the first frame took {arrivals[0]:.2f}s of a "
        f"{FRAMES * FRAME_GAP:.2f}s stream — frames are being batched, not streamed"
    )


def test_a_quiet_stream_is_not_cut_off_by_the_client_deadline(server: str) -> None:
    """The deadline bounds the wait for HEADERS, never the stream itself.

    urlopen's `timeout` is a socket timeout that keeps applying to every later read, which turns
    the request deadline into an inactivity limit the moment the response is a stream. A run
    parked on a human decision emits nothing for as long as it takes someone to answer, so that
    limit would abort exactly the runs a caller most wants to watch.
    """
    # A deadline far shorter than the server's mid-stream silence.
    transport = Transport(base_url=server, api_key="k", timeout=0.3)
    with transport.stream("GET", "/quiet") as stream:
        events = list(stream)

    assert len(events) == FRAMES, "the client deadline severed a healthy but quiet stream"
