// Hand-written (NOT generated): the client a caller constructs.

package ai.catfactory.sdk;

import ai.catfactory.sdk.resources.Resources;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * A cat-factory public-API client.
 *
 * <p>Java:
 *
 * <pre>{@code
 * CatFactoryClient client = CatFactoryClient.builder()
 *         .baseUrl("https://cat-factory.example.com")
 *         .apiKey(System.getenv("CAT_FACTORY_API_KEY"))
 *         .build();
 *
 * PublicService service = client.services().list().services().get(0);
 * PublicTask task = client.tasks().create(
 *         service.serviceId(),
 *         CreatePublicTask.builder().title("Add a health check").build());
 * client.tasks().start(task.taskId(), StartPublicTask.builder().build());
 * }</pre>
 *
 * <p>Kotlin — the same artifact, with real null-safety because the model and resource packages are
 * {@code @NullMarked}:
 *
 * <pre>{@code
 * val client = CatFactoryClient.builder()
 *     .baseUrl("https://cat-factory.example.com")
 *     .apiKey(System.getenv("CAT_FACTORY_API_KEY"))
 *     .build()
 *
 * val service = client.services().list().services.first()   // List<PublicService>, not List<PublicService!>!
 * val task = client.tasks().create(service.serviceId, CreatePublicTask.builder().title("…").build())
 * val pr: String? = task.pullRequestUrl                      // nullable, and the compiler knows it
 * }</pre>
 *
 * <p>Every call is scoped to the key's workspace, and each accessor ({@code tasks()},
 * {@code services()}, …) mirrors one tag of the published OpenAPI surface. The client is stateless
 * beyond its configuration, so one instance is safe to share across threads.
 *
 * <p>The resource accessors are INHERITED from the generated {@link Resources} rather than listed
 * here: a resource group added to the SDK surface table would otherwise generate, compile, and
 * simply not be reachable from the client anyone constructs.
 */
public final class CatFactoryClient extends Resources {

    private final Transport transport;

    private CatFactoryClient(Builder builder) {
        this(new Transport(builder));
    }

    private CatFactoryClient(Transport transport) {
        super(transport);
        this.transport = transport;
    }

    /**
     * Supply the personal password for a key BOUND to a user.
     *
     * <p>It unlocks that user's own model subscription for the runs this client starts, retries and
     * answers parks on, riding every subsequent request as {@code X-Personal-Password}. The
     * deployment never stores it. Pass {@code null} to clear it.
     *
     * <p>Settable after construction because that is when a caller learns it is needed: an operation
     * answers {@code 428 credential_required}, the caller prompts (or reads its secret store), and
     * retries. Rebuilding the client to send one header would discard its configuration and its
     * connection pool.
     */
    public void setPersonalPassword(@Nullable String password) {
        transport.personalPassword(password);
    }

    /** Start building a client. */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Fluent builder.
     *
     * <p>A builder rather than constructor overloads: Java has no default arguments and Kotlin
     * cannot synthesise them for a Java constructor, so a telescoping set would be unpleasant from
     * both languages. From Kotlin this composes with {@code apply { }} directly.
     */
    public static final class Builder {
        private @Nullable String baseUrl;
        private @Nullable String apiKey;
        private Duration timeout = Duration.ofSeconds(30);
        private int maxRetries = 2;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private @Nullable String userAgent;
        private @Nullable HttpClient httpClient;
        private @Nullable String personalPassword;

        /** The deployment's origin, e.g. {@code https://cat-factory.example.com}. Required. */
        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        /** A public-API key of the form {@code cf_live_<keyId>.<secret>}. Required. */
        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }

        /** Per-request deadline. Default 30s. */
        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        /**
         * Retries for a RETRIABLE failure. Default 2.
         *
         * <p>A non-idempotent request is never retried automatically, so raising this does not
         * make {@code jobs().create()} replayable.
         */
        public Builder maxRetries(int maxRetries) {
            this.maxRetries = maxRetries;
            return this;
        }

        /** Add a header sent on every request. */
        public Builder header(String name, String value) {
            this.headers.put(name, value);
            return this;
        }

        /**
         * Prefixed to {@code User-Agent}, so a deployment's logs can attribute calls to your
         * integration.
         */
        public Builder userAgent(String userAgent) {
            this.userAgent = userAgent;
            return this;
        }

        /** Supply your own {@link HttpClient} (a proxy, a custom SSL context, a shared pool). */
        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        /**
         * The personal password of the user this key is BOUND to, if any.
         *
         * <p>Usually supplied later with {@link CatFactoryClient#setPersonalPassword(String)},
         * since a caller learns it is needed from a {@code 428 credential_required}.
         */
        public Builder personalPassword(String personalPassword) {
            this.personalPassword = personalPassword;
            return this;
        }

        /** Build the client. */
        public CatFactoryClient build() {
            if (baseUrl == null || baseUrl.isEmpty()) {
                throw new IllegalArgumentException("cat-factory SDK: baseUrl is required.");
            }
            if (apiKey == null || apiKey.isEmpty()) {
                throw new IllegalArgumentException("cat-factory SDK: apiKey is required.");
            }
            return new CatFactoryClient(this);
        }

        // Package-private accessors the Transport reads. Not public: they are construction
        // details, and widening them would make the builder look like a configuration object a
        // caller is meant to hold onto.
        String baseUrl() {
            return java.util.Objects.requireNonNull(baseUrl);
        }

        String apiKey() {
            return java.util.Objects.requireNonNull(apiKey);
        }

        Duration timeout() {
            return timeout;
        }

        int maxRetries() {
            return maxRetries;
        }

        Map<String, String> headers() {
            return headers;
        }

        @Nullable String userAgent() {
            return userAgent;
        }

        @Nullable HttpClient httpClient() {
            return httpClient;
        }

        @Nullable String personalPassword() {
            return personalPassword;
        }
    }
}
