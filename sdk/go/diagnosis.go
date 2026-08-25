// Hand-written (NOT generated): what a transport failure actually was, and what the client already
// knows about the origin.
//
// The problem this exists for: a failed request used to render as "failed to reach the
// deployment", which is a verdict about REACHABILITY. It is the one provably false reading when
// the deployment answered nine calls two hundred milliseconds earlier and then restarted, and it
// sends the reader to the boot log, the database and the CORS config before the transport is ever
// suspected.
//
// So the SDK says which cause it was, and drops the reachability claim when the cause does not
// support it. The two facts needed for that are already here: the CAUSE is in the error chain, and
// the HISTORY belongs to the Client that made the earlier calls.
//
// A PORT of the platform's own ConnectionFailureCause vocabulary, not an import of it: this SDK
// has no dependencies outside the standard library by design.
//
// What keeps the copy honest is scripts/check-sdk-connection-causes.mjs, a repo-level guard that
// reads the contracts picklist and all four ported lists and fails on any disagreement. It has to
// be a guard rather than a test in here: a test in this package cannot see the picklist, so it
// could only restate the list a second time and would stay green through the exact drift that
// matters. What each cause is MATCHED ON below is this runtime's own business, and is pinned by
// diagnosis_test.go.

package catfactory

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"
)

// failureCause is why a request never produced a response. causeUnknown is a real member: an
// unrecognised chain is reported as itself rather than guessed onto a cause, because a wrong cause
// is what sends a reader to fix something that was never broken.
type failureCause string

const (
	causeRefused       failureCause = "refused"
	causeDNS           failureCause = "dns"
	causeTimeout       failureCause = "timeout"
	causeAborted       failureCause = "aborted"
	causeUnreachable   failureCause = "unreachable"
	causeReset         failureCause = "reset"
	causeTLSUntrusted  failureCause = "tls-untrusted"
	causeTLSExpired    failureCause = "tls-expired"
	causeTLSHostname   failureCause = "tls-hostname"
	causeTLSProtocol   failureCause = "tls-protocol"
	causeInvalidHeader failureCause = "invalid-header"
	causeUnknown       failureCause = "unknown"
)

// originHistory is what this client has seen from the origin, which tells a restart from a bad
// address. A response of ANY status counts as an answer: a 500 is still proof the origin is there.
type originHistory struct {
	// completedCalls is how many requests produced a response.
	completedCalls int
	// sinceLastAnswer is how long ago the last of them answered; only read when completedCalls > 0.
	sinceLastAnswer time.Duration
}

// originTracker is the one owner of what this client has seen from the origin.
//
// The count and the moment are ONE fact, and they are kept behind one lock rather than in two
// atomics because a reader between the two writes of a two-atomic version would see a call
// counted with no answer recorded yet, and the sentence built from that says the origin last
// answered at the zero instant, which renders as "the last 29500000m ago" on the very first
// failure a concurrent client hits. A count that has no matching moment is not a state this type
// can be in, which is a stronger guarantee than a comment telling the reader not to look.
//
// A Client is documented as safe for concurrent use, so this is reached from many goroutines; the
// lock is taken once per completed call and once per failure, neither of which is a hot path
// beside the request they belong to.
type originTracker struct {
	mu           sync.Mutex
	calls        int
	lastAnswered time.Time
}

// recordAnswer notes one answer from the origin.
//
// The clock is read UNDER the lock, as it is in snapshot: a moment captured by the caller before
// it acquires can be older than an answer another goroutine has since recorded, and the age
// computed from that pair comes out NEGATIVE, which renders as an origin that answered in the
// future. Reading both stamps inside the same critical section orders them by construction.
func (t *originTracker) recordAnswer() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.calls++
	t.lastAnswered = time.Now()
}

// snapshot reads both halves together, so the pair a diagnosis is built from is always consistent.
func (t *originTracker) snapshot() originHistory {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.calls == 0 {
		return originHistory{}
	}
	return originHistory{
		completedCalls:  t.calls,
		sinceLastAnswer: time.Since(t.lastAnswered),
	}
}

// classifyTransportFailure names the cause of a whole chain, MOST SPECIFIC first.
//
// The certificate checks lead, because a TLS rejection is delivered wrapped in the *net.OpError
// that carries the connection, and answering with the wrapper is what sends an operator looking
// for a proxy instead of pasting a CA bundle. The text match runs last and is narrow, because a
// message is a guess where a type or a syscall errno is a fact.
func classifyTransportFailure(err error) failureCause {
	if err == nil {
		return causeUnknown
	}
	var unknownAuthority x509.UnknownAuthorityError
	if errors.As(err, &unknownAuthority) {
		return causeTLSUntrusted
	}
	var invalidCert x509.CertificateInvalidError
	if errors.As(err, &invalidCert) {
		if invalidCert.Reason == x509.Expired {
			return causeTLSExpired
		}
		return causeTLSUntrusted
	}
	var hostnameErr x509.HostnameError
	if errors.As(err, &hostnameErr) {
		return causeTLSHostname
	}
	var recordHeader tls.RecordHeaderError
	if errors.As(err, &recordHeader) {
		return causeTLSProtocol
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return causeDNS
	}
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return causeRefused
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE):
		return causeReset
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH),
		errors.Is(err, syscall.ENETDOWN):
		return causeUnreachable
	case errors.Is(err, syscall.ETIMEDOUT), errors.Is(err, context.DeadlineExceeded):
		return causeTimeout
	case errors.Is(err, context.Canceled):
		return causeAborted
	}
	// A net.Error that reports itself as a timeout, for the transports that do not surface an
	// errno at all (a TLS handshake deadline is the common one).
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return causeTimeout
	}
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "invalid header field value"),
		strings.Contains(text, "invalid header field name"):
		return causeInvalidHeader
	case strings.Contains(text, "connection reset by peer"):
		return causeReset
	case strings.Contains(text, "tls: first record does not look like a tls handshake"):
		return causeTLSProtocol
	}
	return causeUnknown
}

// causeVerdict is what happened, in the caller's terms. Every sentence states only what the cause
// supports: a refusal names a port with nothing behind it, a reset names an origin that WAS there,
// and a request rejected before a socket was opened claims nothing about the origin at all.
func causeVerdict(cause failureCause, baseURL string) string {
	switch cause {
	case causeRefused:
		return fmt.Sprintf("nothing is listening at %s", baseURL)
	case causeDNS:
		return fmt.Sprintf("the host %s does not resolve from here", hostOf(baseURL))
	case causeTimeout:
		return fmt.Sprintf("%s did not answer before the connection timed out", baseURL)
	case causeAborted:
		return fmt.Sprintf("the request was cancelled before an answer arrived, so nothing was learned about %s", baseURL)
	case causeUnreachable:
		return fmt.Sprintf("there is no network route to %s from here", baseURL)
	case causeReset:
		return fmt.Sprintf("%s reset the connection before answering", baseURL)
	case causeTLSUntrusted:
		return fmt.Sprintf("%s presented a TLS certificate this client does not trust", baseURL)
	case causeTLSExpired:
		return fmt.Sprintf("the TLS certificate %s presented is outside its validity window", baseURL)
	case causeTLSHostname:
		return fmt.Sprintf("the TLS certificate %s presented was not issued for %s", baseURL, hostOf(baseURL))
	case causeTLSProtocol:
		return fmt.Sprintf("the TLS handshake with %s failed, which is what a plain-HTTP port answers when it is addressed over https", baseURL)
	case causeInvalidHeader:
		return "the request could not be built, because a header value holds a character that is not allowed in one"
	default:
		return fmt.Sprintf("the request to %s ended before any response arrived", baseURL)
	}
}

// hostOf is the host a base URL names, for a sentence about DNS or a certificate.
func hostOf(baseURL string) string {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" {
		return baseURL
	}
	return parsed.Host
}

// renderAge is "0.2s", "12s", "4m": precise where a restart is told from a long-dead origin.
func renderAge(since time.Duration) string {
	if since < 0 {
		since = 0
	}
	if since < 10*time.Second {
		return fmt.Sprintf("%.1fs", since.Seconds())
	}
	if since < time.Minute {
		return fmt.Sprintf("%.0fs", since.Seconds())
	}
	return fmt.Sprintf("%.0fm", since.Minutes())
}

// historyClause states what this client knows about the origin, in BOTH directions: "answered
// nothing yet" is evidence too, and it is what points at the address rather than at the deployment.
func historyClause(history originHistory, baseURL string) string {
	if history.completedCalls == 0 {
		return fmt.Sprintf(" This client has not completed a call against %s yet.", baseURL)
	}
	calls := fmt.Sprintf("%d calls", history.completedCalls)
	if history.completedCalls == 1 {
		calls = "1 call"
	}
	return fmt.Sprintf(" This client had answered %s against %s, the last %s ago.",
		calls, baseURL, renderAge(history.sinceLastAnswer))
}

// describeTransportFailure is what happened, what this client knows about the origin, and the
// exact error the runtime reported, in that order. The runtime's own text stays LAST and stays
// verbatim: it is the evidence, and a reader who disagrees with the classification needs it.
func describeTransportFailure(method, path, baseURL string, err error, history originHistory) string {
	verdict := causeVerdict(classifyTransportFailure(err), baseURL)
	return fmt.Sprintf("cat-factory: %s %s failed: %s.%s (%v)",
		method, path, verdict, historyClause(history, baseURL), err)
}
