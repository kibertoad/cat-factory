// Hand-written (NOT generated).

package ai.catfactory.sdk;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** 401 — no key, or a key that has been revoked. */
public final class CatFactoryUnauthorizedException extends CatFactoryApiException {
    CatFactoryUnauthorizedException(
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
