// The transport's connection DIAGNOSIS: which cause a chain names, and what history adds to it.
//
// Unreachable from the cross-SDK smoketest, which drives a healthy deployment over a real socket,
// and silent when wrong: the call still throws the exception a caller catches, carrying a sentence
// that sends them to the wrong place. A reset and a refusal are the pair that matters, because
// they take opposite investigations (a deployment that is there and restarted, versus an address
// with nothing behind it) and the SDK used to render both as `failed to reach <baseUrl>`.

package ai.catfactory.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketException;
import java.net.UnknownHostException;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateExpiredException;
import javax.net.ssl.SSLHandshakeException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class ConnectionDiagnosisTest {

    private static final String BASE_URL = "https://cat.example.test";

    /** What the JDK actually throws: the real failure under the IOException that carried it. */
    private static IOException wrapped(Throwable inner) {
        return new IOException("request failed", inner);
    }

    private static String describe(Throwable error, ConnectionDiagnosis.OriginHistory history) {
        return ConnectionDiagnosis.describe("POST", "/api/v1/tasks", BASE_URL, error, history);
    }

    @Test
    @DisplayName("reads the DEEPEST link, not the wrapper")
    void readsTheDeepestLink() {
        assertEquals(
                ConnectionDiagnosis.Cause.REFUSED,
                ConnectionDiagnosis.classify(wrapped(new ConnectException("Connection refused"))));
        assertEquals(
                ConnectionDiagnosis.Cause.DNS,
                ConnectionDiagnosis.classify(wrapped(new UnknownHostException("cat.example.test"))));
        assertEquals(
                ConnectionDiagnosis.Cause.RESET,
                ConnectionDiagnosis.classify(wrapped(new SocketException("Connection reset"))));
    }

    /** A handshake failure carrying the certificate fault that actually caused it. */
    private static Throwable handshake(String message, Throwable cause) {
        SSLHandshakeException failure = new SSLHandshakeException(message);
        failure.initCause(cause);
        return failure;
    }

    @Test
    @DisplayName("separates the TLS failures by what fixes them")
    void separatesTlsFailures() {
        // The three take three different actions: paste a CA bundle, renew the certificate,
        // correct the scheme. Collapsing them sends an operator to the wrong one.
        assertEquals(
                ConnectionDiagnosis.Cause.TLS_UNTRUSTED,
                ConnectionDiagnosis.classify(
                        handshake(
                                "PKIX path building failed",
                                new CertPathValidatorException("unable to find valid path"))));
        assertEquals(
                ConnectionDiagnosis.Cause.TLS_EXPIRED,
                ConnectionDiagnosis.classify(
                        handshake(
                                "PKIX path validation failed",
                                new CertificateExpiredException("NotAfter"))));
        assertEquals(
                ConnectionDiagnosis.Cause.TLS_PROTOCOL,
                ConnectionDiagnosis.classify(
                        new SSLHandshakeException("Unrecognized SSL message, plaintext connection?")));
    }

    @Test
    @DisplayName("answers UNKNOWN rather than guessing at a chain it does not recognise")
    void answersUnknown() {
        assertEquals(
                ConnectionDiagnosis.Cause.UNKNOWN,
                ConnectionDiagnosis.classify(new IOException("something else entirely")));
    }

    @Test
    @DisplayName("renders a reset and a refusal differently, and neither as a reachability verdict")
    void rendersResetAndRefusalDifferently() {
        String reset =
                describe(
                        wrapped(new SocketException("Connection reset")),
                        new ConnectionDiagnosis.OriginHistory(9, 200));
        assertTrue(reset.contains("reset the connection before answering"), reset);
        assertTrue(reset.contains("had answered 9 calls"), reset);
        assertTrue(reset.contains("the last 0.2s ago"), reset);
        assertTrue(reset.contains("Connection reset"), reset);
        assertFalse(reset.contains("failed to reach"), reset);

        String refused =
                describe(
                        wrapped(new ConnectException("Connection refused")),
                        ConnectionDiagnosis.OriginHistory.NONE);
        assertTrue(refused.contains("nothing is listening at " + BASE_URL), refused);
        assertTrue(refused.contains("has not completed a call against " + BASE_URL + " yet"), refused);
    }
}
