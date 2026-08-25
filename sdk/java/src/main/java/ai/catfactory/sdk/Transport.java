// Hand-written (NOT generated): the one place that knows about auth, retries, timeouts and error
// mapping. The generated operation methods do nothing but describe a request and hand it here.

package ai.catfactory.sdk;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import org.jspecify.annotations.Nullable;

/**
 * Performs requests against a deployment, applying auth, deadlines and the retry policy.
 *
 * <p>Built on {@link java.net.http.HttpClient} from the JDK, so the SDK's only runtime dependency
 * is Jackson (for JSON) plus JSpecify's annotations (which are compile-time only). A client
 * library's dependencies become every consumer's dependencies.
 *
 * <p>Public because the generated resource clients live in a sibling package, but not part of the
 * surface a caller is expected to touch: build a {@link CatFactoryClient} instead.
 */
public final class Transport {

    /** SDK version, stamped into {@code User-Agent}. Kept in step with pom.xml by {@code check:sdk}. */
    public static final String SDK_VERSION = "0.6.0";

    /**
     * Methods that may be replayed after a failure.
     *
     * <p>A transport failure with no response tells us nothing about whether the server acted, so
     * only a method idempotent BY DEFINITION is replayed. {@code POST /jobs} and
     * {@code POST /tasks/:id/start} both cost real LLM work, and a duplicate is not something the
     * SDK may decide to risk on the caller's behalf.
     */
    private static final Set<String> IDEMPOTENT = Set.of("GET", "HEAD", "DELETE");

    private static final Set<Integer> RETRIABLE_STATUS = Set.of(429, 502, 503, 504);

    private final HttpClient http;
    private final ObjectMapper mapper;
    private final String baseUrl;
    private final String apiKey;
    private final Duration timeout;
    private final int maxRetries;
    private final Map<String, String> headers;
    private final Random jitter = new Random();

    /**
     * What this client has seen from the origin, so a transport failure can say whether the
     * deployment was answering a moment ago.
     *
     * <p>A response of ANY status counts: a 500 is still proof the origin is there, and that is the
     * difference between "it restarted" and "that address never answered", which are the two
     * readings a bare "failed to reach" collapses.
     *
     * <p>The count and the moment are held as ONE reference rather than as two {@code AtomicLong}s
     * because they are one fact. With two, a reader landing between the two writes sees a call
     * counted with no answer recorded yet, and the sentence built from that pair says the origin
     * last answered at the epoch, which renders as "the last 29500000m ago" on the very first
     * failure a concurrent client hits. As one reference, a count with no matching moment is not a
     * state this field can hold. A client is documented as safe to share across threads.
     */
    private final AtomicReference<Answered> answered = new AtomicReference<>(Answered.NONE);

    /**
     * One answer tally: how many responses this transport has seen and when the last arrived.
     *
     * @param calls responses received, of any status
     * @param atMillis when the last of them arrived; meaningless when {@code calls} is zero
     */
    private record Answered(long calls, long atMillis) {
        static final Answered NONE = new Answered(0L, 0L);
    }

    /**
     * The personal password sent on every request while set, for a key BOUND to a user.
     *
     * <p>The one mutable piece of a Transport's configuration, and {@code volatile} because of it: a
     * client is documented as safe to share across threads, and this is settable after construction
     * (a caller learns it is needed from a {@code 428 credential_required}).
     */
    private volatile @Nullable String personalPassword;

    Transport(CatFactoryClient.Builder options) {
        this.baseUrl = options.baseUrl().replaceAll("/+$", "");
        this.apiKey = options.apiKey();
        this.timeout = options.timeout();
        this.maxRetries = options.maxRetries();
        this.http =
                options.httpClient() != null
                        ? options.httpClient()
                        : HttpClient.newBuilder()
                                .connectTimeout(Duration.ofSeconds(10))
                                // Pin the protocol by SCHEME. `HttpClient`'s default is HTTP/2,
                                // and over a CLEARTEXT connection that means an h2c upgrade —
                                // every request goes out carrying `Connection: Upgrade,
                                // HTTP2-Settings` and `Upgrade: h2c`. A server that does not
                                // speak h2c is not obliged to ignore it, and the Node facade
                                // answers such a request with a 404: every call fails, with a
                                // status that says "no such route" about a route that exists.
                                // Over TLS the negotiation is ALPN instead, which is clean — so
                                // HTTP/2 is kept for `https` and only cleartext drops to 1.1,
                                // rather than giving up h2 everywhere. A caller who wants
                                // different behaviour supplies their own client.
                                .version(
                                        baseUrl.startsWith("https://")
                                                ? HttpClient.Version.HTTP_2
                                                : HttpClient.Version.HTTP_1_1)
                                .build();
        this.mapper =
                new ObjectMapper()
                        // The surface is additive forever: a deployment WILL send fields this SDK
                        // release has no component for, and failing to decode because of one would
                        // turn every additive server release into an outage for anyone who had not
                        // upgraded.
                        .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
                        .setSerializationInclusion(JsonInclude.Include.ALWAYS);
        Map<String, String> merged = new LinkedHashMap<>();
        merged.put("accept", "application/json");
        String agent = options.userAgent() == null ? "" : options.userAgent() + " ";
        merged.put("user-agent", agent + "cat-factory-sdk-java/" + SDK_VERSION);
        merged.putAll(options.headers());
        this.headers = Map.copyOf(merged);
        this.personalPassword = options.personalPassword();
    }

    /** @see CatFactoryClient#setPersonalPassword(String) */
    void personalPassword(@Nullable String password) {
        this.personalPassword = password;
    }

    /**
     * Percent-encode a path parameter.
     *
     * <p>An id is server-supplied but travels through a caller's own storage, and one carrying a
     * {@code /} would otherwise re-target the request at a different route rather than 404 on the
     * id it names.
     */
    public static String pathSegment(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    /** Perform a request and decode its JSON body. */
    public <T> T request(
            String method,
            String path,
            @Nullable Object body,
            Map<String, String> query,
            TypeReference<T> type) {
        String text = send(method, path, body, query, "application/json");
        try {
            return mapper.readValue(text, type);
        } catch (IOException cause) {
            throw new CatFactoryDecodeException(
                    "cat-factory SDK: " + method + " " + path + " returned a body that is not JSON.",
                    text,
                    cause);
        }
    }

    /** Perform a request whose success carries no body (a 204). */
    public void requestNoContent(
            String method, String path, @Nullable Object body, Map<String, String> query) {
        send(method, path, body, query, "application/json");
    }

    /**
     * Perform a request whose success carries BYTES rather than JSON (an artifact download).
     *
     * <p>Returned whole rather than as a stream: the listing endpoint that hands out these ids
     * also carries each artifact's exact {@code byteSize}, so a caller decides whether to fetch
     * BEFORE issuing the request, and every artifact is bounded by the platform's own upload
     * ceiling.
     *
     * <p>The Accept header is the wildcard because the endpoint declares SEVERAL media types
     * (the image allow-list plus an {@code application/octet-stream} fallback) and answers with
     * whichever one the stored artifact is; naming any single one would disagree with most of
     * what it sends.
     */
    public byte[] requestBytes(
            String method, String path, @Nullable Object body, Map<String, String> query) {
        return sendBytes(method, path, body, query, "*/*");
    }

    /**
     * Open a server-sent event stream.
     *
     * <p>Deliberately NOT retried: a reconnect would replay the stream from its start, and the
     * caller — who knows which events it has already acted on — is the only party that can decide
     * whether that is safe.
     */
    public EventStream stream(String method, String path, Map<String, String> query) {
        HttpRequest request = buildOrDiagnose(method, path, null, query, "text/event-stream");
        try {
            HttpResponse<InputStream> response =
                    http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            recordAnswer();
            if (response.statusCode() >= 400) {
                throw toApiException(response.statusCode(), readAll(response.body()), requestId(response));
            }
            return new EventStream(response.body());
        } catch (IOException cause) {
            throw new CatFactoryConnectionException(diagnose(method, path, cause), cause);
        } catch (InterruptedException cause) {
            Thread.currentThread().interrupt();
            throw new CatFactoryConnectionException(
                    "cat-factory SDK: " + method + " " + path + " was interrupted.", cause);
        }
    }

    // -- internals ---------------------------------------------------------------------------

    private String send(
            String method,
            String path,
            @Nullable Object body,
            Map<String, String> query,
            String accept) {
        return new String(sendBytes(method, path, body, query, accept), StandardCharsets.UTF_8);
    }

    /**
     * The one retrying exchange every unary call goes through, reading the body as BYTES.
     *
     * <p>Bytes rather than a String is what lets a binary response reuse the retry, timeout and
     * error-mapping policy verbatim instead of growing a second copy of it beside a different
     * body handler; a JSON caller decodes UTF-8 on the way out, which is what it was doing
     * anyway.
     */
    private byte[] sendBytes(
            String method,
            String path,
            @Nullable Object body,
            Map<String, String> query,
            String accept) {
        for (int attempt = 0; ; attempt++) {
            HttpRequest request = buildOrDiagnose(method, path, body, query, accept);
            try {
                HttpResponse<byte[]> response =
                        http.send(request, HttpResponse.BodyHandlers.ofByteArray());
                recordAnswer();
                if (response.statusCode() < 400) {
                    return response.body();
                }
                boolean retriable =
                        IDEMPOTENT.contains(method) && RETRIABLE_STATUS.contains(response.statusCode());
                if (attempt < maxRetries && retriable) {
                    // Honour `Retry-After` when the server states one: it is the deployment's own
                    // knowledge of when the limit clears, which beats a blind backoff curve.
                    java.util.OptionalLong stated = retryAfterMillis(response);
                    sleep(stated.isPresent() ? stated.getAsLong() : backoffMillis(attempt));
                    continue;
                }
                throw toApiException(
                        response.statusCode(),
                        new String(response.body(), StandardCharsets.UTF_8),
                        requestId(response));
            } catch (HttpTimeoutException cause) {
                if (attempt < maxRetries && IDEMPOTENT.contains(method)) {
                    sleep(backoffMillis(attempt));
                    continue;
                }
                throw new CatFactoryTimeoutException(
                        "cat-factory SDK: " + method + " " + path + " exceeded " + timeout + ".", cause);
            } catch (IOException cause) {
                if (attempt < maxRetries && IDEMPOTENT.contains(method)) {
                    sleep(backoffMillis(attempt));
                    continue;
                }
                throw new CatFactoryConnectionException(diagnose(method, path, cause), cause);
            } catch (InterruptedException cause) {
                Thread.currentThread().interrupt();
                throw new CatFactoryConnectionException(
                        "cat-factory SDK: " + method + " " + path + " was interrupted.", cause);
            }
        }
    }

    /** Note that the origin ANSWERED, which is what a later failure is read against. */
    private void recordAnswer() {
        // Read the clock OUTSIDE the update: `updateAndGet` may re-apply its function when the
        // compare-and-set loses, and a function that read the clock itself would then be timing
        // the contention rather than the answer.
        long now = System.currentTimeMillis();
        answered.updateAndGet(prior -> new Answered(prior.calls() + 1L, now));
    }

    /**
     * The classified account of a transport failure: what happened, what this client had seen from
     * the origin, then the runtime's own chain. The cause is still attached to the exception, so a
     * caller unwrapping it finds exactly what the JDK reported.
     */
    private String diagnose(String method, String path, Throwable cause) {
        Answered seen = answered.get();
        ConnectionDiagnosis.OriginHistory history =
                seen.calls() == 0
                        ? ConnectionDiagnosis.OriginHistory.NONE
                        : new ConnectionDiagnosis.OriginHistory(
                                seen.calls(), System.currentTimeMillis() - seen.atMillis());
        return ConnectionDiagnosis.describe(method, path, baseUrl, cause, history);
    }

    /**
     * Build a request, or report the failure to build one the same way every other transport
     * failure is reported.
     *
     * <p>The JDK raises {@link IllegalArgumentException} from {@code HttpRequest.Builder.build()}
     * for a header value carrying a control character, and from {@code URI.create} for a base URL
     * that is not a URI. Both happen BEFORE a socket exists, and both used to escape this class
     * raw: {@code ConnectionDiagnosis.Cause#INVALID_HEADER} existed with nothing able to reach it,
     * so an API key pasted with a line break in it surfaced as a bare JDK exception rather than as
     * the one sentence that names what a caller has to fix.
     *
     * <p>Deliberately NOT retried, unlike a transport failure: the same inputs build the same
     * rejection every time, so a retry spends the budget to arrive at the identical message.
     */
    private HttpRequest buildOrDiagnose(
            String method,
            String path,
            @Nullable Object body,
            Map<String, String> query,
            String accept) {
        try {
            return build(method, path, body, query, accept);
        } catch (IllegalArgumentException cause) {
            throw new CatFactoryConnectionException(diagnose(method, path, cause), cause);
        }
    }

    private HttpRequest build(
            String method,
            String path,
            @Nullable Object body,
            Map<String, String> query,
            String accept) {
        HttpRequest.Builder builder =
                HttpRequest.newBuilder(URI.create(baseUrl + path + renderQuery(query))).timeout(timeout);
        // `setHeader`, never `header`: the latter APPENDS, so a caller who put `authorization` in
        // their own headers got two of them on the wire and a deployment refusing the request for
        // a reason nothing in their code names. Caller headers are applied FIRST and the SDK's own
        // three overwrite them, because those three are what makes the request THIS SDK's: an
        // Authorization the transport did not build, or an Accept that disagrees with how the
        // response will be read, are not customisations — they are the client not working.
        headers.forEach(builder::setHeader);
        String password = personalPassword;
        if (password != null) {
            builder.setHeader("x-personal-password", password);
        }
        builder.setHeader("authorization", "Bearer " + apiKey);
        builder.setHeader("accept", accept);
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.setHeader("content-type", "application/json");
            builder.method(method, HttpRequest.BodyPublishers.ofString(writeJson(body)));
        }
        return builder.build();
    }

    private String writeJson(Object body) {
        try {
            return mapper.writeValueAsString(body);
        } catch (IOException cause) {
            throw new CatFactoryDecodeException(
                    "cat-factory SDK: the request body could not be encoded as JSON.", "", cause);
        }
    }

    /** Serialize the query bag, dropping absent values so {@code ?limit=null} is impossible. */
    private static String renderQuery(Map<String, String> query) {
        List<String> pairs = new ArrayList<>();
        query.forEach(
                (key, value) -> {
                    if (value != null) {
                        pairs.add(
                                URLEncoder.encode(key, StandardCharsets.UTF_8)
                                        + "="
                                        + URLEncoder.encode(value, StandardCharsets.UTF_8));
                    }
                });
        return pairs.isEmpty() ? "" : "?" + String.join("&", pairs);
    }

    /**
     * Build the typed exception for a failed response.
     *
     * <p>A body that is not the documented envelope (a proxy's HTML error page, a truncated
     * stream) still yields a usable error: the status is always known, and the unparsed body is
     * retained rather than discarded, so a caller diagnosing an unexpected failure is not left
     * with "something went wrong".
     */
    private CatFactoryApiException toApiException(
            int status, String rawBody, @Nullable String requestId) {
        String code = status >= 500 ? "internal" : "unknown";
        String message = "HTTP " + status;
        Object details = null;
        List<Map<String, Object>> issues = List.of();
        try {
            Map<String, Object> parsed =
                    mapper.readValue(rawBody, new TypeReference<Map<String, Object>>() {});
            Object envelope = parsed.get("error");
            if (envelope instanceof Map<?, ?> raw) {
                // Re-key through a String-keyed view: a wildcard-keyed map cannot be queried with
                // a String literal, and the JSON we just parsed can only have String keys anyway.
                Map<String, Object> error = castIssue(raw);
                code = String.valueOf(error.getOrDefault("code", code));
                message = String.valueOf(error.getOrDefault("message", message));
                details = error.get("details");
                if (error.get("issues") instanceof List<?> issueList) {
                    issues =
                            issueList.stream()
                                    .filter(Map.class::isInstance)
                                    .map(item -> castIssue((Map<?, ?>) item))
                                    .collect(Collectors.toList());
                }
            }
        } catch (IOException ignored) {
            // Not the documented envelope. The status and the raw body below still describe the
            // failure, which is strictly better than replacing them with a parse error about it.
        }
        return switch (status) {
            case 400, 422 -> new CatFactoryValidationException(
                    status, code, message, details, issues, requestId, rawBody);
            case 401 -> new CatFactoryUnauthorizedException(
                    status, code, message, details, issues, requestId, rawBody);
            case 403 -> new CatFactoryForbiddenException(
                    status, code, message, details, issues, requestId, rawBody);
            case 404 -> new CatFactoryNotFoundException(
                    status, code, message, details, issues, requestId, rawBody);
            case 409 -> new CatFactoryConflictException(
                    status, code, message, details, issues, requestId, rawBody);
            case 428 -> new CatFactoryCredentialRequiredException(
                    status, code, message, details, issues, requestId, rawBody);
            case 429 -> new CatFactoryRateLimitedException(
                    status, code, message, details, issues, requestId, rawBody);
            // A 5xx is the deployment faulting. Anything else unmapped — a 402, a 413, a 415, or
            // a status this surface gains later — stays the BASE class rather than being folded
            // into the server one: the surface is additive forever, and presenting a refusal the
            // caller caused as a deployment fault sends them to look at the wrong system. The
            // status and `code` are on the exception either way, so nothing is lost by declining
            // to guess at the class.
            default -> status >= 500
                    ? new CatFactoryServerException(
                            status, code, message, details, issues, requestId, rawBody)
                    : new CatFactoryApiException(
                            status, code, message, details, issues, requestId, rawBody);
        };
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castIssue(Map<?, ?> raw) {
        return (Map<String, Object>) raw;
    }

    private static @Nullable String requestId(HttpResponse<?> response) {
        return response.headers().firstValue("x-request-id").orElse(null);
    }

    private static String readAll(InputStream stream) {
        try (stream) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException exc) {
            return "";
        }
    }

    /**
     * {@code Retry-After} in milliseconds, capped at a minute, or empty when absent/unparsable.
     *
     * <p>Both wire forms RFC 9110 allows: delta-seconds, and an HTTP-date, which a proxy or CDN in
     * front of the deployment routinely writes instead. Reading only the numeric form silently
     * discarded the deployment's own knowledge of when the limit clears and fell back to a blind
     * backoff curve — which still works, just worse, so nothing would ever have surfaced it.
     */
    private java.util.OptionalLong retryAfterMillis(HttpResponse<?> response) {
        return response
                .headers()
                .firstValue("retry-after")
                .map(header -> parseRetryAfter(header.trim()))
                .orElseGet(java.util.OptionalLong::empty);
    }

    private static java.util.OptionalLong parseRetryAfter(String header) {
        try {
            return java.util.OptionalLong.of(clampRetryAfter(Long.parseLong(header) * 1000L));
        } catch (NumberFormatException notSeconds) {
            // Not delta-seconds, so try the date form below.
        }
        try {
            java.time.ZonedDateTime at =
                    java.time.ZonedDateTime.parse(
                            header, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME);
            return java.util.OptionalLong.of(
                    clampRetryAfter(
                            java.time.Duration.between(java.time.ZonedDateTime.now(at.getZone()), at)
                                    .toMillis()));
        } catch (java.time.format.DateTimeParseException notADate) {
            return java.util.OptionalLong.empty();
        }
    }

    private static long clampRetryAfter(long millis) {
        return Math.max(0L, Math.min(millis, 60_000L));
    }

    /** Full jitter on an exponential base, so a fleet of clients does not retry in lockstep. */
    private long backoffMillis(int attempt) {
        return (long) (jitter.nextDouble() * Math.min(8_000L, 250L * (1L << attempt)));
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException exc) {
            Thread.currentThread().interrupt();
        }
    }
}
