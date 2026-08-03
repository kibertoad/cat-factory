// Hand-written (NOT generated).

package ai.catfactory.sdk;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** 400 / 422 — the request was malformed, or a domain rule refused it. */
public final class CatFactoryValidationException extends CatFactoryApiException {
    CatFactoryValidationException(
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
