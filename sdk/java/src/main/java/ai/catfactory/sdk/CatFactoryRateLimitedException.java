// Hand-written (NOT generated).

package ai.catfactory.sdk;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** 429 — rate limited, or a counted cap is already full ({@code too_many_active_runs}). */
public final class CatFactoryRateLimitedException extends CatFactoryApiException {
    CatFactoryRateLimitedException(
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
