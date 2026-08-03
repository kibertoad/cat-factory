// Hand-written (NOT generated): the SDK's error types.
//
// Every failure the API reports arrives as one envelope — {"error": {"code", "message",
// "details"?, "issues"?}} — and the SDK turns it into a typed error. Which type you get is decided
// by the HTTP STATUS, never by Code.
//
// That split is deliberate. /api/v1 puts two families of value in error.code: the status-class
// codes (validation, not_found, conflict, …) and codes specific to this surface
// (insufficient_scope, invalid_cursor, pipeline_not_public, too_many_active_runs, …), and the
// surface is additive forever — new codes appear without a major version. So the status is the
// part that is safe to branch a TYPE on, and Code is exposed verbatim as a string for a caller to
// branch on precisely. Narrowing Code to a closed set here would mean an SDK release is required
// before a caller could even name a refusal the server already sends, and a copy of the vocabulary
// would be a second place for it to go stale. The authoritative list is backend/docs/public-api.md.

package catfactory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// ConnectionError means the request never produced an HTTP response: DNS, TCP, TLS, or a dropped
// socket. Unwrap it for the underlying cause.
type ConnectionError struct {
	Method string
	Path   string
	Err    error
}

func (e *ConnectionError) Error() string {
	return fmt.Sprintf("cat-factory: %s %s failed to reach the deployment: %v", e.Method, e.Path, e.Err)
}

func (e *ConnectionError) Unwrap() error { return e.Err }

// TimeoutError means the request exceeded the client-side deadline (Options.Timeout), so no
// verdict was reached.
//
// Kept apart from ConnectionError because the two need DIFFERENT reactions — a longer budget can
// fix a timeout and cannot fix a refused connection — and because collapsing them is what makes
// "the deployment is unreachable" indistinguishable from "this call is slow". The other three
// SDKs draw the same line (CatFactoryTimeoutError / CatFactoryTimeoutException).
//
// On a STREAM the deadline covers only the wait for response headers; once the stream is open it
// runs for as long as the caller's context allows.
type TimeoutError struct {
	Method  string
	Path    string
	Timeout time.Duration
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("cat-factory: %s %s exceeded its %s deadline", e.Method, e.Path, e.Timeout)
}

// Unwrap reports context.DeadlineExceeded, so errors.Is(err, context.DeadlineExceeded) holds for
// callers who reach for the standard-library idiom rather than IsTimeout.
func (e *TimeoutError) Unwrap() error { return context.DeadlineExceeded }

// IsTimeout reports whether err is the client-side deadline being exceeded.
func IsTimeout(err error) bool {
	var timeoutErr *TimeoutError
	return errors.As(err, &timeoutErr)
}

// ErrRepeatedCursor is yielded by an auto-pager when the server answers a page with the SAME
// nextCursor it was just given.
//
// That is a server fault, and the pagers stop rather than follow it — the walk would otherwise
// never terminate, re-fetching one page forever against a caller's rate limit. It is reported
// rather than swallowed because a silent stop is indistinguishable from a completed walk, and a
// caller acting on "these are all the tasks" when they have seen one page is the worse failure.
var ErrRepeatedCursor = errors.New(
	"cat-factory: the server repeated a pagination cursor; stopping rather than looping forever",
)

// DecodeError means a 2xx response whose body was not the JSON the contract promises — in practice
// a proxy or gateway answering in the deployment's place.
//
// RawBody is retained because "invalid JSON" on its own does not tell you that something in front
// of the backend returned an HTML error page.
type DecodeError struct {
	Method  string
	Path    string
	RawBody string
	Err     error
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("cat-factory: %s %s returned a body that is not JSON: %v", e.Method, e.Path, e.Err)
}

func (e *DecodeError) Unwrap() error { return e.Err }

// APIError means the server answered, and the answer was a refusal.
//
// Test the status class with the Is* helpers (or errors.As plus a Status comparison), and branch on
// Code for the specific cause.
type APIError struct {
	// Status is the HTTP status.
	Status int
	// Code is the machine-readable error.code — see the file note. Branch on this, not on Message.
	Code string
	// Message is operator prose. Not localized, and not a stable identifier.
	Message string
	// Details is error.details, whose shape depends on Code. Nil when the server sent none.
	Details json.RawMessage
	// Issues holds per-field validation failures, when the server reported any.
	Issues []APIErrorIssue
	// RequestID is the X-Request-Id of the failing call — what correlates it with the
	// deployment's own logs, and the id to quote when reporting a fault.
	RequestID string
	// RawBody is the body as received, for a failure whose Details this SDK does not model.
	RawBody string
}

// APIErrorIssue is one per-field validation failure.
type APIErrorIssue struct {
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("cat-factory: %d %s: %s", e.Status, e.Code, e.Message)
}

// IsUnauthorized reports a 401: no key, or a key that has been revoked.
func IsUnauthorized(err error) bool { return hasStatus(err, http.StatusUnauthorized) }

// IsForbidden reports a 403: a key whose scope is too low (insufficient_scope), or a forbidden action.
func IsForbidden(err error) bool { return hasStatus(err, http.StatusForbidden) }

// IsNotFound reports a 404: no such resource, or one outside this key's workspace (the two are
// indistinguishable, on purpose).
func IsNotFound(err error) bool { return hasStatus(err, http.StatusNotFound) }

// IsConflict reports a 409: the resource is not in a state that admits this action.
func IsConflict(err error) bool { return hasStatus(err, http.StatusConflict) }

// IsValidation reports a 400 or 422: the request was malformed, or a domain rule refused it.
func IsValidation(err error) bool {
	return hasStatus(err, http.StatusBadRequest) || hasStatus(err, http.StatusUnprocessableEntity)
}

// IsCredentialRequired reports a 428: a credential the action needs has not been supplied.
func IsCredentialRequired(err error) bool { return hasStatus(err, http.StatusPreconditionRequired) }

// IsRateLimited reports a 429: rate limited, or a counted cap is already full
// (too_many_active_runs).
func IsRateLimited(err error) bool { return hasStatus(err, http.StatusTooManyRequests) }

// IsServerError reports a 5xx: the deployment faulted, or a dependency it needs is unavailable.
func IsServerError(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status >= 500
}

// HasCode reports whether err is an APIError carrying the given machine-readable code, e.g.
// "insufficient_scope" or "too_many_active_runs".
func HasCode(err error, code string) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Code == code
}

func hasStatus(err error, status int) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == status
}

// toAPIError builds the typed error for a failed response.
//
// A body that is not the documented envelope (a proxy's HTML error page, a truncated stream) still
// yields a usable error: the status is always known, and the unparsed body is retained on RawBody
// rather than discarded, so a caller diagnosing an unexpected failure is not left with "something
// went wrong".
func toAPIError(status int, body []byte, requestID string) *APIError {
	apiErr := &APIError{
		Status:    status,
		Code:      "unknown",
		Message:   fmt.Sprintf("HTTP %d", status),
		RequestID: requestID,
		RawBody:   string(body),
	}
	if status >= 500 {
		apiErr.Code = "internal"
	}

	var envelope struct {
		Error struct {
			Code    string          `json:"code"`
			Message string          `json:"message"`
			Details json.RawMessage `json:"details"`
			Issues  []APIErrorIssue `json:"issues"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil {
		if envelope.Error.Code != "" {
			apiErr.Code = envelope.Error.Code
		}
		if envelope.Error.Message != "" {
			apiErr.Message = envelope.Error.Message
		}
		apiErr.Details = envelope.Error.Details
		apiErr.Issues = envelope.Error.Issues
	}
	return apiErr
}
