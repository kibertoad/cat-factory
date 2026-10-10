// Hand-written (NOT generated).

package ai.catfactory.sdk;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** 403 — a valid key whose scope is too low ({@code insufficient_scope}), or a forbidden action. */
public final class CatFactoryForbiddenException extends CatFactoryApiException {
    CatFactoryForbiddenException(
            int status,
            String code,
            String apiMessage,
            @Nullable Object details,
            List<Map<String, Object>> issues,
            @Nullable String requestId,
            @Nullable String rawBody) {
        super(status, code, apiMessage, details, issues, requestId, rawBody);
    }
}
