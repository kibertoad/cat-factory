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
    public static final String SDK_VERSION = "0.1.0";

    /**
     * Methods that may be replayed after a failure.
     *
     * <p>A transport failure with no response tells us nothing about whether the server acted, so
     * only a method idempotent BY DEFINITION is replayed. {@code POST /initiatives} and
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
     * Open a server-sent event stream.
     *
     * <p>Deliberately NOT retried: a reconnect would replay the stream from its start, and the
     * caller — who knows which events it has already acted on — is the only party that can decide
     * whether that is safe.
     */
    public EventStream stream(String method, String path, Map<String, String> query) {
        HttpRequest request = build(method, path, null, query, "text/event-stream");
        try {
            HttpResponse<InputStream> response =
                    http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            if (response.statusCode() >= 400) {
                throw toApiException(response.statusCode(), readAll(response.body()), requestId(response));
            }
            return new EventStream(response.body());
        } catch (IOException cause) {
            throw new CatFactoryConnectionException(
                    "cat-factory SDK: " + method + " " + path + " failed to reach " + baseUrl + ".",
                    cause);
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
        for (int attempt = 0; ; attempt++) {
            HttpRequest request = build(method, path, body, query, accept);
            try {
                HttpResponse<String> response =
                        http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
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
                throw toApiException(response.statusCode(), response.body(), requestId(response));
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
                throw new CatFactoryConnectionException(
                        "cat-factory SDK: " + method + " " + path + " failed to reach " + baseUrl + ".",
                        cause);
            } catch (InterruptedException cause) {
                Thread.currentThread().interrupt();
                throw new CatFactoryConnectionException(
                        "cat-factory SDK: " + method + " " + path + " was interrupted.", cause);
            }
        }
    }

    private HttpRequest build(
            String method,
            String path,
            @Nullable Object body,
            Map<String, String> query,
            String accept) {
        HttpRequest.Builder builder =
                HttpRequest.newBuilder(URI.create(baseUrl + path + renderQuery(query)))
                        .timeout(timeout)
                        .header("authorization", "Bearer " + apiKey)
                        .header("accept", accept);
        headers.forEach(
                (key, value) -> {
                    if (!key.equalsIgnoreCase("accept")) {
                        builder.header(key, value);
                    }
                });
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.header("content-type", "application/json");
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
            default -> new CatFactoryServerException(
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

    private java.util.OptionalLong retryAfterMillis(HttpResponse<?> response) {
        return response
                .headers()
                .firstValue("retry-after")
                .map(
                        header -> {
                            try {
                                return java.util.OptionalLong.of(
                                        Math.min(Long.parseLong(header.trim()) * 1000L, 60_000L));
                            } catch (NumberFormatException exc) {
                                return java.util.OptionalLong.empty();
                            }
                        })
                .orElseGet(java.util.OptionalLong::empty);
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
