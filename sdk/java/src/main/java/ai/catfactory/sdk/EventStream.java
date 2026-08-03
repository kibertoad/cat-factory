// Hand-written (NOT generated): the server-sent-events reader for the two streaming endpoints.

package ai.catfactory.sdk;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import org.jspecify.annotations.Nullable;

/**
 * An iterable stream of server-sent events.
 *
 * <p>Use it in a try-with-resources so the socket is released rather than held against the
 * deployment's per-connection cap:
 *
 * <pre>{@code
 * try (EventStream stream = client.tasks().stream(taskId)) {
 *     for (StreamEvent event : stream) {
 *         if (event.event().equals("done") || event.event().equals("error")) break;
 *     }
 * }
 * }</pre>
 *
 * <p>The framing rules implemented here are the ones a naive split on blank lines gets wrong, and
 * getting them wrong shows up as a run that silently appears to stall: a chunk boundary can fall
 * inside a {@code data:} line, a record may carry several {@code data:} lines that join with a
 * newline, and a record left unterminated when the socket closes is still a record the server sent
 * — dropping it would lose exactly the terminal {@code done} frame when the server closes the
 * connection in the same breath as emitting it.
 */
public final class EventStream implements Iterable<StreamEvent>, Closeable {

    private final BufferedReader reader;
    private boolean closed;

    EventStream(InputStream body) {
        this.reader = new BufferedReader(new InputStreamReader(body, StandardCharsets.UTF_8));
    }

    @Override
    public Iterator<StreamEvent> iterator() {
        return new Iterator<>() {
            private @Nullable StreamEvent next = advance();

            @Override
            public boolean hasNext() {
                return next != null;
            }

            @Override
            public StreamEvent next() {
                StreamEvent current = next;
                if (current == null) {
                    throw new NoSuchElementException();
                }
                next = advance();
                return current;
            }

            private @Nullable StreamEvent advance() {
                List<String> record = new ArrayList<>();
                try {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (line.isEmpty()) {
                            StreamEvent decoded = decode(record);
                            record.clear();
                            if (decoded != null) {
                                return decoded;
                            }
                            continue;
                        }
                        record.add(line);
                    }
                } catch (IOException exc) {
                    throw new CatFactoryConnectionException(
                            "cat-factory SDK: the event stream failed mid-read.", exc);
                }
                // Trailing, unterminated record — see the class note.
                return record.isEmpty() ? null : decode(record);
            }
        };
    }

    private static @Nullable StreamEvent decode(List<String> lines) {
        String event = "message";
        String id = null;
        List<String> data = new ArrayList<>();
        for (String line : lines) {
            // A leading colon is a comment — servers send them as keep-alives. Never a record.
            if (line.startsWith(":")) {
                continue;
            }
            int colon = line.indexOf(':');
            String field = colon == -1 ? line : line.substring(0, colon);
            String raw = colon == -1 ? "" : line.substring(colon + 1);
            // One optional leading space after the colon is framing, not value.
            String value = raw.startsWith(" ") ? raw.substring(1) : raw;
            switch (field) {
                case "event" -> event = value;
                case "data" -> data.add(value);
                case "id" -> id = value;
                default -> {
                    // An unknown field (`retry:`, or one added later) is ignored, per the spec.
                }
            }
        }
        if (data.isEmpty() && event.equals("message")) {
            return null;
        }
        return new StreamEvent(event, String.join("\n", data), id);
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        try {
            reader.close();
        } catch (IOException exc) {
            // The socket is already gone — that is the state we were trying to reach.
        }
    }
}
