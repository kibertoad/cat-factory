// The transport's connection DIAGNOSIS: which cause a chain names, and what history adds to it.
//
// Unreachable from the cross-SDK smoketest, which drives a healthy deployment over a real socket,
// and silent when wrong: the call still returns the *ConnectionError a caller checks for, carrying
// a sentence that sends them to the wrong place. A reset and a refusal are the pair that matters,
// because they take opposite investigations (a deployment that is there and restarted, versus an
// address with nothing behind it) and the SDK used to render both as "failed to reach the
// deployment".

package catfactory

import (
	"crypto/x509"
	"fmt"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"
)

// wrapped is what net/http actually returns: the syscall error inside the operation that carried
// it, inside url.Error. Reading only the outermost link renders every one of these the same way.
func wrapped(inner error) error {
	opErr := &net.OpError{Op: "read", Net: "tcp", Err: inner}
	return fmt.Errorf("Post \"https://cat.example.test/api/v1/tasks\": %w", opErr)
}

func TestClassifyReadsThroughTheWrappers(t *testing.T) {
	cases := map[error]failureCause{
		syscall.ECONNREFUSED: causeRefused,
		syscall.ECONNRESET:   causeReset,
		syscall.EHOSTUNREACH: causeUnreachable,
		syscall.ETIMEDOUT:    causeTimeout,
	}
	for inner, want := range cases {
		if got := classifyTransportFailure(wrapped(inner)); got != want {
			t.Fatalf("classify(%v) = %q, want %q", inner, got, want)
		}
	}
	dns := &net.DNSError{Err: "no such host", Name: "cat.example.test", IsNotFound: true}
	if got := classifyTransportFailure(fmt.Errorf("dial: %w", dns)); got != causeDNS {
		t.Fatalf("classify(DNSError) = %q, want %q", got, causeDNS)
	}
}

func TestClassifySeparatesTheTLSFailuresByWhatFixesThem(t *testing.T) {
	// The three take three different actions: paste a CA bundle, renew the certificate, correct
	// the host name. Collapsing them is what sends an operator to the wrong one.
	untrusted := fmt.Errorf("tls: %w", x509.UnknownAuthorityError{})
	if got := classifyTransportFailure(untrusted); got != causeTLSUntrusted {
		t.Fatalf("classify(UnknownAuthority) = %q, want %q", got, causeTLSUntrusted)
	}
	expired := fmt.Errorf("tls: %w", x509.CertificateInvalidError{Reason: x509.Expired})
	if got := classifyTransportFailure(expired); got != causeTLSExpired {
		t.Fatalf("classify(Expired) = %q, want %q", got, causeTLSExpired)
	}
	hostname := fmt.Errorf("tls: %w", x509.HostnameError{Host: "cat.example.test"})
	if got := classifyTransportFailure(hostname); got != causeTLSHostname {
		t.Fatalf("classify(HostnameError) = %q, want %q", got, causeTLSHostname)
	}
}

func TestClassifyAnswersUnknownRatherThanGuessing(t *testing.T) {
	if got := classifyTransportFailure(fmt.Errorf("something else entirely")); got != causeUnknown {
		t.Fatalf("classify(unrecognised) = %q, want %q", got, causeUnknown)
	}
}

func TestDescribeRendersAResetAndARefusalDifferently(t *testing.T) {
	reset := describeTransportFailure("POST", "/api/v1/tasks", "https://cat.example.test",
		wrapped(syscall.ECONNRESET),
		originHistory{completedCalls: 9, sinceLastAnswer: 200 * time.Millisecond})
	for _, want := range []string{
		"reset the connection before answering",
		"had answered 9 calls",
		"the last 0.2s ago",
		"connection reset by peer",
	} {
		if !strings.Contains(reset, want) {
			t.Fatalf("describe(reset) = %q, want it to contain %q", reset, want)
		}
	}
	if strings.Contains(reset, "failed to reach") {
		t.Fatalf("describe(reset) = %q, want no reachability verdict", reset)
	}

	refused := describeTransportFailure("POST", "/api/v1/tasks", "https://cat.example.test",
		wrapped(syscall.ECONNREFUSED), originHistory{})
	for _, want := range []string{
		"nothing is listening at https://cat.example.test",
		"has not completed a call against https://cat.example.test yet",
	} {
		if !strings.Contains(refused, want) {
			t.Fatalf("describe(refused) = %q, want it to contain %q", refused, want)
		}
	}
}

func TestConnectionErrorFallsBackWhenBuiltOutsideTheTransport(t *testing.T) {
	// The diagnosis is unexported, so a value a caller (or a test) builds by hand still renders.
	err := &ConnectionError{Method: "GET", Path: "/api/v1/tasks", Err: syscall.ECONNRESET}
	if !strings.Contains(err.Error(), "failed to reach the deployment") {
		t.Fatalf("Error() = %q, want the plain rendering", err.Error())
	}
}
