// The SSE reader's framing rules.
//
// The cross-SDK smoketest proves the stream works end to end, but it cannot provoke the cases that
// actually bite — a read boundary landing mid-record, a multi-line payload, a terminal frame
// arriving in the same breath as the socket closing. Each of those shows up in production as a run
// that silently appears to stall, so each gets a test that constructs the byte sequence directly.
//
// The TypeScript SDK has the mirror of this file (`sdk/typescript/test/sse.test.ts`). The two
// readers are independent implementations of one wire format, so they need independent tests —
// the smoketest only compares what they observed, not how they framed it.

package ai.catfactory.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class EventStreamTest {

    private static List<StreamEvent> collect(String body) {
        List<StreamEvent> events = new ArrayList<>();
        try (EventStream stream =
                new EventStream(new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)))) {
            for (StreamEvent event : stream) {
                events.add(event);
            }
        }
        return events;
    }

    @Test
    @DisplayName("decodes a well-formed record")
    void decodesARecord() {
        List<StreamEvent> events = collect("event: progress\ndata: {\"runId\":\"r1\"}\n\n");
        assertEquals(1, events.size());
        assertEquals("progress", events.get(0).event());
        assertEquals(
                Map.of("runId", "r1"),
                events.get(0).json(new TypeReference<Map<String, Object>>() {}));
    }

    @Test
    @DisplayName("joins multiple data lines with a newline")
    void joinsDataLines() {
        // Per the SSE spec. Taking only the last line would silently truncate a payload.
        List<StreamEvent> events = collect("event: progress\ndata: line one\ndata: line two\n\n");
        assertEquals("line one\nline two", events.get(0).data());
    }

    @Test
    @DisplayName("yields a trailing record the server sent without a terminating blank line")
    void yieldsUnterminatedTrailingRecord() {
        // The case that matters: a server closing the connection in the same breath as its terminal
        // frame. Dropping the unterminated record loses exactly the `done` the caller waits for.
        List<StreamEvent> events =
                collect("event: progress\ndata: {}\n\nevent: done\ndata: {\"ok\":true}\n");
        assertEquals(List.of("progress", "done"), events.stream().map(StreamEvent::event).toList());
    }

    @Test
    @DisplayName("ignores comment keep-alives")
    void ignoresKeepAlives() {
        // Servers send `:` lines to hold the connection open. Treating one as a record would hand
        // the caller a phantom event on a perfectly healthy stream.
        List<StreamEvent> events = collect(": keep-alive\n\nevent: done\ndata: {}\n\n");
        assertEquals(List.of("done"), events.stream().map(StreamEvent::event).toList());
    }

    @Test
    @DisplayName("accepts CRLF line endings")
    void acceptsCrlf() {
        // A proxy that normalizes line endings would otherwise make the stream appear to emit
        // nothing at all, because no complete record would ever be recognised.
        List<StreamEvent> events = collect("event: progress\r\ndata: {\"a\":1}\r\n\r\n");
        assertEquals(1, events.size());
        assertEquals("progress", events.get(0).event());
    }

    @Test
    @DisplayName("strips exactly one leading space after the colon")
    void stripsOneLeadingSpace() {
        // The single space is framing; a second one is payload.
        assertEquals(" padded", collect("event: progress\ndata:  padded\n\n").get(0).data());
    }

    @Test
    @DisplayName("defaults the event name to `message` when the server sends none")
    void defaultsEventName() {
        assertEquals("message", collect("data: {\"a\":1}\n\n").get(0).event());
    }

    @Test
    @DisplayName("returns null from json() for a payload that is not JSON")
    void jsonReturnsNullForNonJson() {
        // Returning null rather than throwing: a non-JSON frame mid-stream is normal, and a client
        // that raised on one would fail on a healthy connection.
        StreamEvent event = collect("event: progress\ndata: not json\n\n").get(0);
        assertNull(event.json(new TypeReference<Map<String, Object>>() {}));
    }

    @Test
    @DisplayName("closes the underlying stream")
    void closesUnderlyingStream() {
        var tracker = new ClosingStream("event: progress\ndata: {}\n\n");
        try (EventStream stream = new EventStream(tracker)) {
            for (StreamEvent ignored : stream) {
                break;
            }
        }
        assertTrue(tracker.closed, "the SDK must release the socket rather than hold it open");
    }

    /** An input stream that records whether it was closed. */
    private static final class ClosingStream extends InputStream {
        private final ByteArrayInputStream delegate;
        private boolean closed;

        ClosingStream(String body) {
            this.delegate = new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public int read() {
            return delegate.read();
        }

        @Override
        public int read(byte[] b, int off, int len) {
            return delegate.read(b, off, len);
        }

        @Override
        public void close() throws IOException {
            closed = true;
            delegate.close();
        }
    }
}
