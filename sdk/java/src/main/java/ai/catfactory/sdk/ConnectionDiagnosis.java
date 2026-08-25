// Hand-written (NOT generated): what a transport failure actually was, and what the client already
// knows about the origin.

package ai.catfactory.sdk;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.PortUnreachableException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.http.HttpTimeoutException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.CertPathValidatorException;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLException;
import org.jspecify.annotations.Nullable;

/**
 * Why a request never produced a response, and the sentence that says so.
 *
 * <p>The problem this exists for: an {@link IOException} from the JDK's HttpClient used to render
 * as {@code failed to reach <baseUrl>}, which is a verdict about REACHABILITY. It is the one
 * provably false reading when the deployment answered nine calls two hundred milliseconds earlier
 * and then restarted, and it sends the reader to the boot log, the database and the CORS config
 * before the transport is ever suspected.
 *
 * <p>So the SDK says which cause it was, and drops the reachability claim when the cause does not
 * support it. The two facts needed for that are already here: the CAUSE is in the exception chain,
 * and the HISTORY belongs to the {@link Transport} that made the earlier calls.
 *
 * <p>A PORT of the platform's own {@code ConnectionFailureCause} vocabulary, not an import of it:
 * this SDK's only runtime dependency is Jackson, by design.
 *
 * <p>What keeps the copy honest is {@code scripts/check-sdk-connection-causes.mjs}, a repo-level
 * guard that reads the contracts picklist and all four ported lists and fails on any disagreement.
 * It has to be a guard rather than a test in here: a test in this package cannot see the picklist,
 * so it could only restate the list a second time and would stay green through the exact drift
 * that matters. What each cause is MATCHED ON below is this runtime's own business, and is pinned
 * by {@code ConnectionDiagnosisTest}.
 */
final class ConnectionDiagnosis {

    private ConnectionDiagnosis() {}

    /**
     * Why a request never produced a response. {@code UNKNOWN} is a real member: an unrecognised
     * chain is reported as itself rather than guessed onto a cause, because a wrong cause is what
     * sends a reader to fix something that was never broken.
     */
    enum Cause {
        REFUSED,
        DNS,
        TIMEOUT,
        ABORTED,
        UNREACHABLE,
        RESET,
        TLS_UNTRUSTED,
        TLS_EXPIRED,
        TLS_HOSTNAME,
        TLS_PROTOCOL,
        INVALID_HEADER,
        UNKNOWN
    }

    /**
     * What this client has seen from the origin, which tells a restart from a bad address. A
     * response of ANY status counts as an answer: a 500 is still proof the origin is there.
     *
     * @param completedCalls requests that produced a response
     * @param sinceLastAnswerMillis how long ago the last of them answered; read only when
     *     {@code completedCalls > 0}
     */
    record OriginHistory(long completedCalls, long sinceLastAnswerMillis) {
        static final OriginHistory NONE = new OriginHistory(0, 0);
    }

    /** OpenSSL-side wordings that mean the handshake never reached a certificate. */
    private static final Set<String> TLS_PROTOCOL_TEXT =
            Set.of(
                    "unrecognized ssl message",
                    "wrong version number",
                    "plaintext connection",
                    "record version",
                    "unsupported protocol");

    /** Bounded, because a chain can be cyclic or arbitrarily deep. */
    private static final int MAX_CHAIN_LINKS = 12;

    /** The throwable and everything under it, outermost first. */
    private static List<Throwable> chain(Throwable error) {
        List<Throwable> links = new ArrayList<>();
        Map<Throwable, Boolean> seen = new IdentityHashMap<>();
        Throwable link = error;
        while (link != null && links.size() < MAX_CHAIN_LINKS && seen.put(link, Boolean.TRUE) == null) {
            links.add(link);
            link = link.getCause();
        }
        return links;
    }

    private static @Nullable Cause classifyOne(Throwable link) {
        // Read once at the top: the JDK gives several of these conditions no type of their own,
        // only the wording the OS reported, and the ConnectException branch below needs it too.
        String text = link.getMessage() == null ? "" : link.getMessage().toLowerCase(Locale.ROOT);
        // The certificate checks lead, because a TLS rejection arrives wrapped in the
        // SSLHandshakeException that carried it: answering with the wrapper is what sends an
        // operator looking for a proxy instead of pasting a CA bundle.
        if (link instanceof CertificateExpiredException || link instanceof CertificateNotYetValidException) {
            return Cause.TLS_EXPIRED;
        }
        if (link instanceof CertPathValidatorException) {
            return Cause.TLS_UNTRUSTED;
        }
        if (link instanceof SSLPeerUnverifiedException) {
            return Cause.TLS_HOSTNAME;
        }
        if (link instanceof UnknownHostException) {
            return Cause.DNS;
        }
        if (link instanceof ConnectException) {
            // NOT unconditionally REFUSED. `java.net.ConnectException` is what the JDK raises for
            // a refusal AND for an OS-level connect timeout ("Connection timed out"), which is
            // reachable whenever the caller supplies an HttpClient with no connectTimeout: the
            // JDK never gets to raise its own HttpConnectTimeoutException, and the kernel's
            // ETIMEDOUT surfaces under this type instead. Answering REFUSED there produces
            // "nothing is listening at ...", which is the exact false reachability verdict this
            // class exists to remove: the packets were dropped IN FRONT of a deployment that may
            // well be running. It is also the one condition on which this client would disagree
            // with the other three, all of which read the errno. Only the wording separates a
            // refusal from a timeout here, so the wording is what decides.
            if (text.contains("timed out") || text.contains("timeout")) {
                return Cause.TIMEOUT;
            }
            if (text.contains("network is unreachable") || text.contains("no route to host")) {
                return Cause.UNREACHABLE;
            }
            return Cause.REFUSED;
        }
        if (link instanceof NoRouteToHostException || link instanceof PortUnreachableException) {
            return Cause.UNREACHABLE;
        }
        if (link instanceof HttpTimeoutException || link instanceof SocketTimeoutException) {
            return Cause.TIMEOUT;
        }
        if (link instanceof InterruptedException) {
            return Cause.ABORTED;
        }
        if (link instanceof SSLHandshakeException || link instanceof SSLException) {
            for (String wording : TLS_PROTOCOL_TEXT) {
                if (text.contains(wording)) {
                    return Cause.TLS_PROTOCOL;
                }
            }
            if (text.contains("hostname") || text.contains("subject alternative")) {
                return Cause.TLS_HOSTNAME;
            }
            if (text.contains("expired")) {
                return Cause.TLS_EXPIRED;
            }
            return Cause.TLS_UNTRUSTED;
        }
        if (link instanceof SocketException) {
            // The JDK gives a reset no type of its own, only the wording the OS reported.
            if (text.contains("connection reset") || text.contains("broken pipe")) {
                return Cause.RESET;
            }
            if (text.contains("network is unreachable")) {
                return Cause.UNREACHABLE;
            }
            return null;
        }
        if (link instanceof IllegalArgumentException && text.contains("header")) {
            return Cause.INVALID_HEADER;
        }
        return null;
    }

    /**
     * The cause of a whole chain, DEEPEST-FIRST: depth is specificity order, and the outer links
     * are the generic wrappers the JDK puts over the one that names the failure.
     */
    static Cause classify(@Nullable Throwable error) {
        if (error == null) {
            return Cause.UNKNOWN;
        }
        List<Throwable> links = chain(error);
        for (int index = links.size() - 1; index >= 0; index--) {
            Cause recognised = classifyOne(links.get(index));
            if (recognised != null) {
                return recognised;
            }
        }
        return Cause.UNKNOWN;
    }

    /** The chain as the runtime reported it, deduplicated and leading with what it named. */
    static String renderChain(@Nullable Throwable error) {
        if (error == null) {
            return "";
        }
        List<String> parts = new ArrayList<>();
        for (Throwable link : chain(error)) {
            String message = link.getMessage();
            String text =
                    message == null || message.isBlank()
                            ? link.getClass().getSimpleName()
                            : message.strip();
            if (!parts.contains(text)) {
                parts.add(text);
            }
        }
        return String.join(": ", parts);
    }

    /** The host a base URL names, for a sentence about DNS or a certificate. */
    private static String hostOf(String baseUrl) {
        try {
            String host = URI.create(baseUrl).getHost();
            return host == null ? baseUrl : host;
        } catch (IllegalArgumentException ignored) {
            return baseUrl;
        }
    }

    /**
     * What happened, stating only what the cause supports: a refusal names a port with nothing
     * behind it, a reset names an origin that WAS there, and a request rejected before a socket was
     * opened claims nothing about the origin at all.
     */
    private static String verdict(Cause cause, String baseUrl) {
        return switch (cause) {
            case REFUSED -> "nothing is listening at " + baseUrl;
            case DNS -> "the host " + hostOf(baseUrl) + " does not resolve from here";
            case TIMEOUT -> baseUrl + " did not answer before the connection timed out";
            case ABORTED ->
                    "the request was cancelled before an answer arrived, so nothing was learned about "
                            + baseUrl;
            case UNREACHABLE -> "there is no network route to " + baseUrl + " from here";
            case RESET -> baseUrl + " reset the connection before answering";
            case TLS_UNTRUSTED ->
                    baseUrl + " presented a TLS certificate this client does not trust";
            case TLS_EXPIRED ->
                    "the TLS certificate " + baseUrl + " presented is outside its validity window";
            case TLS_HOSTNAME ->
                    "the TLS certificate "
                            + baseUrl
                            + " presented was not issued for "
                            + hostOf(baseUrl);
            case TLS_PROTOCOL ->
                    "the TLS handshake with "
                            + baseUrl
                            + " failed, which is what a plain-HTTP port answers when it is addressed over https";
            case INVALID_HEADER ->
                    "the request could not be built, because a header value holds a character that is not allowed in one";
            case UNKNOWN -> "the request to " + baseUrl + " ended before any response arrived";
        };
    }

    /** {@code 0.2s}, {@code 12s}, {@code 4m}: precise where a restart is told from a dead origin. */
    private static String renderAge(long millis) {
        double seconds = Math.max(0L, millis) / 1000.0;
        if (seconds < 10) {
            return String.format(Locale.ROOT, "%.1fs", seconds);
        }
        if (seconds < 60) {
            return String.format(Locale.ROOT, "%.0fs", seconds);
        }
        return String.format(Locale.ROOT, "%.0fm", seconds / 60);
    }

    /**
     * What this client knows about the origin, in BOTH directions: "answered nothing yet" is
     * evidence too, and it is what points at the address rather than at the deployment.
     */
    private static String history(OriginHistory history, String baseUrl) {
        if (history.completedCalls() == 0) {
            return " This client has not completed a call against " + baseUrl + " yet.";
        }
        String calls =
                history.completedCalls() == 1 ? "1 call" : history.completedCalls() + " calls";
        return " This client had answered "
                + calls
                + " against "
                + baseUrl
                + ", the last "
                + renderAge(history.sinceLastAnswerMillis())
                + " ago.";
    }

    /**
     * What happened, what this client knows about the origin, and the exact chain the runtime
     * reported, in that order. The chain stays LAST and stays verbatim: it is the evidence, and a
     * reader who disagrees with the classification needs it unedited.
     */
    static String describe(
            String method,
            String path,
            String baseUrl,
            @Nullable Throwable error,
            OriginHistory history) {
        String chain = renderChain(error);
        String evidence = chain.isEmpty() ? "" : " (" + chain + ")";
        return "cat-factory SDK: "
                + method
                + " "
                + path
                + " failed: "
                + verdict(classify(error), baseUrl)
                + "."
                + history(history, baseUrl)
                + evidence;
    }
}
