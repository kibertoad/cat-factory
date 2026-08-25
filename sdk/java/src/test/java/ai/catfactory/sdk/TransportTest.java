// The transport's request building and failure classification.
//
// These are the decisions the generated resource clients delegate entirely — which headers go on
// the wire, and which exception class a caller catches — and neither is reachable from the
// cross-SDK smoketest, which drives a healthy deployment and never sends a header of its own. A
// misclassification here is silent: the call still throws, just the wrong thing.

package ai.catfactory.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.core.type.TypeReference;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class TransportTest {

    /** Serve one canned response, recording the request headers it was called with. */
    private record Recorded(Map<String, List<String>> headers, HttpServer server) {}

    private static Recorded serve(int status, String body) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var captured = new java.util.concurrent.ConcurrentHashMap<String, List<String>>();
        server.createContext(
                "/",
                exchange -> {
                    exchange.getRequestHeaders().forEach(captured::put);
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(status, payload.length);
                    try (OutputStream out = exchange.getResponseBody()) {
                        out.write(payload);
                    }
                });
        server.start();
        return new Recorded(captured, server);
    }

    /**
     * A Transport straight from a Builder. The test lives in the transport's own package, so it
     * drives the unit under test directly rather than reaching through a client whose only job
     * here would be to hold it.
     */
    private static Transport transportFor(HttpServer server, Map<String, String> headers) {
        CatFactoryClient.Builder builder =
                CatFactoryClient.builder()
                        .baseUrl("http://127.0.0.1:" + server.getAddress().getPort())
                        .apiKey("cf_live_key.secret")
                        .maxRetries(0)
                        .timeout(Duration.ofSeconds(5));
        headers.forEach(builder::header);
        return new Transport(builder);
    }

    @Test
    @DisplayName("a caller-supplied authorization header does not duplicate the SDK's own")
    void callerHeadersDoNotDuplicateTheSdkOwned() throws IOException {
        // `HttpRequest.Builder.header` APPENDS. Applying caller headers through it put two
        // `authorization` values on the wire, and a deployment refusing the request for a reason
        // nothing in the caller's code names.
        Recorded recorded = serve(200, "{}");
        try {
            Transport transport =
                    transportFor(
                            recorded.server(),
                            Map.of("authorization", "Bearer someone-elses", "x-trace", "t-1"));
            transport.request(
                    "GET", "/thing", null, Map.of(), new TypeReference<Map<String, Object>>() {});

            List<String> authorization = recorded.headers().get("Authorization");
            assertEquals(1, authorization.size(), "expected exactly one authorization header");
            assertEquals("Bearer cf_live_key.secret", authorization.getFirst());
            // An unrelated caller header still rides along — the SDK owns three headers, not all.
            assertEquals(List.of("t-1"), recorded.headers().get("X-trace"));
        } finally {
            recorded.server().stop(0);
        }
    }

    @Test
    @DisplayName("an unmapped 4xx stays the base class rather than becoming a server fault")
    void unmappedClientStatusIsNotAServerException() throws IOException {
        // The surface is additive forever. Folding every unmapped status into the 5xx class told
        // a caller the deployment had faulted when in fact their own request was refused, sending
        // them to look at the wrong system.
        Recorded recorded = serve(402, "{\"error\":{\"code\":\"payment_required\",\"message\":\"Nope\"}}");
        try {
            Transport transport = transportFor(recorded.server(), Map.of());
            CatFactoryApiException thrown =
                    assertThrows(
                            CatFactoryApiException.class,
                            () ->
                                    transport.request(
                                            "GET",
                                            "/thing",
                                            null,
                                            Map.of(),
                                            new TypeReference<Map<String, Object>>() {}));
            assertEquals(402, thrown.status());
            assertEquals("payment_required", thrown.code());
            assertFalse(
                    thrown instanceof CatFactoryServerException,
                    "a 402 is the caller's refusal, not the deployment faulting");
        } finally {
            recorded.server().stop(0);
        }
    }

    @Test
    @DisplayName("a 5xx is still a server exception")
    void serverStatusIsAServerException() throws IOException {
        Recorded recorded = serve(503, "{\"error\":{\"code\":\"unavailable\",\"message\":\"Down\"}}");
        try {
            Transport transport = transportFor(recorded.server(), Map.of());
            CatFactoryApiException thrown =
                    assertThrows(
                            CatFactoryApiException.class,
                            () ->
                                    transport.request(
                                            "GET",
                                            "/thing",
                                            null,
                                            Map.of(),
                                            new TypeReference<Map<String, Object>>() {}));
            assertInstanceOf(CatFactoryServerException.class, thrown);
            assertEquals("unavailable", thrown.code());
        } finally {
            recorded.server().stop(0);
        }
    }

    @Test
    @DisplayName("a request the JDK refuses to BUILD is diagnosed, not thrown raw")
    void aRequestTheJdkRefusesToBuildIsDiagnosed() throws IOException {
        // `HttpRequest.Builder.build()` raises IllegalArgumentException for a header value holding
        // a control character, before any socket exists. It sat OUTSIDE the try, so it escaped the
        // transport as a bare JDK exception: a caller who pasted an API key with a line break in
        // it got a stack trace naming nothing they could act on, and the INVALID_HEADER cause had
        // no way to be produced at all.
        Recorded recorded = serve(200, "{}");
        try {
            Transport transport =
                    transportFor(recorded.server(), Map.of("x-trace", "line-one\nline-two"));
            CatFactoryConnectionException failure =
                    assertThrows(
                            CatFactoryConnectionException.class,
                            () ->
                                    transport.request(
                                            "GET",
                                            "/thing",
                                            null,
                                            Map.of(),
                                            new TypeReference<Map<String, Object>>() {}));
            assertTrue(
                    failure.getMessage().contains("not allowed in one"),
                    "expected the invalid-header sentence, got: " + failure.getMessage());
        } finally {
            recorded.server().stop(0);
        }
    }

    @Test
    @DisplayName("a stream the JDK refuses to BUILD is diagnosed the same way")
    void aStreamTheJdkRefusesToBuildIsDiagnosed() throws IOException {
        // The second call site. `stream` built its request outside the try as well, so the two
        // had to be fixed together or an SSE caller kept the raw throw.
        Recorded recorded = serve(200, "");
        try {
            Transport transport =
                    transportFor(recorded.server(), Map.of("x-trace", "line-one\nline-two"));
            assertThrows(
                    CatFactoryConnectionException.class,
                    () -> transport.stream("GET", "/events", Map.of()));
        } finally {
            recorded.server().stop(0);
        }
    }
}
