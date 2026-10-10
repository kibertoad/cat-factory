// Hand-written (NOT generated).

package ai.catfactory.sdk;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** 428 — a credential the action needs has not been supplied. */
public final class CatFactoryCredentialRequiredException extends CatFactoryApiException {
    CatFactoryCredentialRequiredException(
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
