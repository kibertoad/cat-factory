// Hand-written (NOT generated).

package ai.catfactory.sdk;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import org.jspecify.annotations.Nullable;

/**
 * One decoded server-sent event.
 *
 * @param event the {@code event:} field, or {@code message} when the server sent none (the SSE
 *     default).
 * @param data the joined {@code data:} payload, verbatim.
 * @param id the {@code id:} field, when the server sent one.
 */
public record StreamEvent(String event, String data, @Nullable String id) {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * {@link #data()} parsed as {@code T}, or null when it is not JSON (e.g. a bare keep-alive).
     *
     * <p>Returns null rather than throwing: a keep-alive frame arriving mid-stream is normal, and
     * a client that raised on one would fail on a healthy connection.
     */
    public <T> @Nullable T json(TypeReference<T> type) {
        try {
            return MAPPER.readValue(data, type);
        } catch (IOException exc) {
            return null;
        }
    }
}
