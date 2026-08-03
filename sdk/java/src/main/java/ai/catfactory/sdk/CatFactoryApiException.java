// Hand-written (NOT generated): the API's own refusals, typed by status class.

package ai.catfactory.sdk;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The server answered, and the answer was a refusal.
 *
 * <p>Which subclass you get is decided by the HTTP <b>status</b>, never by {@link #code()}. That
 * split is deliberate: {@code /api/v1} puts two families of value in {@code error.code} — the
 * status-class codes ({@code validation}, {@code not_found}, {@code conflict}, …) and codes
 * specific to this surface ({@code insufficient_scope}, {@code invalid_cursor},
 * {@code pipeline_not_public}, {@code too_many_active_runs}, …) — and the surface is additive
 * forever, so new codes appear without a major version. The status is the part that is safe to
 * branch a <i>class</i> on; {@code code()} is exposed verbatim as a {@code String} for a caller to
 * branch on precisely.
 *
 * <p>Narrowing {@code code()} to an enum here would mean an SDK release is required before a
 * caller could even name a refusal the server already sends, and a copy of the vocabulary would be
 * a second place for it to go stale. The authoritative list is {@code backend/docs/public-api.md}.
 */
public sealed class CatFactoryApiException extends CatFactoryException
        permits CatFactoryValidationException,
                CatFactoryUnauthorizedException,
                CatFactoryForbiddenException,
                CatFactoryNotFoundException,
                CatFactoryConflictException,
                CatFactoryCredentialRequiredException,
                CatFactoryRateLimitedException,
                CatFactoryServerException {

    private final int status;
    private final String code;
    private final String apiMessage;
    private final @Nullable Object details;
    private final List<Map<String, Object>> issues;
    private final @Nullable String requestId;
    private final @Nullable String rawBody;

    CatFactoryApiException(
            int status,
            String code,
            String apiMessage,
            @Nullable Object details,
            List<Map<String, Object>> issues,
            @Nullable String requestId,
            @Nullable String rawBody) {
        super(status + " " + code + ": " + apiMessage, null);
        this.status = status;
        this.code = code;
        this.apiMessage = apiMessage;
        this.details = details;
        this.issues = List.copyOf(issues);
        this.requestId = requestId;
        this.rawBody = rawBody;
    }

    /** The HTTP status. */
    public int status() {
        return status;
    }

    /** The machine-readable {@code error.code} — see the class note. Branch on this, not on text. */
    public String code() {
        return code;
    }

    /** Operator prose. Not localized, and not a stable identifier — do not branch on it. */
    public String apiMessage() {
        return apiMessage;
    }

    /** {@code error.details}, whose shape depends on {@link #code()}. */
    public @Nullable Object details() {
        return details;
    }

    /** Per-field validation failures, when the server reported any. Never null; may be empty. */
    public List<Map<String, Object>> issues() {
        return issues;
    }

    /**
     * The {@code X-Request-Id} of the failing call.
     *
     * <p>Every response carries one, and it is what correlates this call with the deployment's own
     * logs — the id to quote when reporting a fault.
     */
    public @Nullable String requestId() {
        return requestId;
    }

    /** The raw body, for a failure whose {@link #details()} this SDK does not model. */
    public @Nullable String rawBody() {
        return rawBody;
    }
}
