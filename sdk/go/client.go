// Hand-written (NOT generated): the transport and the client a caller constructs.
//
// The generated resource services in operations_gen.go do nothing but describe a request and hand
// it here, so any change to HOW the SDK talks to a deployment is a change to this file alone.

// Package catfactory is the Go client for the cat-factory public API (/api/v1).
//
// The models and the 38 operation methods are generated from the deployment's published OpenAPI
// spec, so they cannot drift from the API they talk to. The transport, errors and SSE framing are
// hand-written.
//
// The package has NO dependencies outside the standard library.
//
//	client, err := catfactory.New(catfactory.Options{
//		BaseURL: "https://cat-factory.example.com",
//		APIKey:  os.Getenv("CAT_FACTORY_API_KEY"),
//	})
//	if err != nil {
//		return err
//	}
//	services, err := client.Services.List(ctx)
package catfactory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Version is the SDK version, stamped into User-Agent. Kept in step by `pnpm check:sdk`.
const Version = "0.25.0"

// Options configures a Client.
type Options struct {
	// BaseURL is the deployment's origin, e.g. https://cat-factory.example.com. Required.
	BaseURL string
	// APIKey is a public-API key of the form cf_live_<keyId>.<secret>. Required.
	APIKey string
	// Timeout is the per-request deadline. Zero means 30s; use a context to cancel individually.
	Timeout time.Duration
	// MaxRetries bounds retries of a RETRIABLE failure. Zero means 2.
	//
	// A non-idempotent request is never retried automatically, so raising this does not make
	// Jobs.Create replayable.
	MaxRetries int
	// Header is sent on every request.
	Header http.Header
	// HTTPClient replaces the default (a proxy, a custom transport, a shared pool).
	HTTPClient *http.Client
	// UserAgent is prefixed to the SDK's own, so a deployment's logs can attribute calls to your
	// integration.
	UserAgent string
}

// Client is a cat-factory public-API client.
//
// Every call is scoped to the key's workspace, and each field mirrors one tag of the published
// OpenAPI surface. A Client is stateless beyond its configuration and safe for concurrent use.
type Client struct {
	baseURL    string
	apiKey     string
	timeout    time.Duration
	maxRetries int
	header     http.Header
	httpClient *http.Client

	// Headless jobs: a public, inline pipeline run against a brief.
	Jobs *JobsService
	// The workspace's board services.
	Services *ServicesService
	// The repositories a service can be created against.
	Repos *ReposService
	// Board tasks: create, edit, start, stop, retry, watch, delete.
	Tasks *TasksService
	// The pipelines a task can be started with.
	Pipelines *PipelinesService
	// What a task can be created AS here, and the fields each type accepts.
	TaskTypes *TaskTypesService
	// The workspace's human-actionable inbox.
	Notifications *NotificationsService
	// The workspace's one outbound endpoint for pushed notifications, run events and alerts.
	Webhook *WebhookService
	// The period's metered budget position and per-model breakdown.
	Usage *UsageService
	// A parked run's human decisions.
	Decisions *DecisionsService
	// A run's recorded telemetry, for diagnosing one that went wrong.
	Debug *DebugService
	// What the calling key is and what it may do.
	Me *MeService
	// What a run proved: its verification report and captured artifacts.
	Evidence *EvidenceService
	// The workspace's own API keys.
	Keys *KeysService
}

// New builds a Client, or returns an error when the required options are missing.
func New(options Options) (*Client, error) {
	if options.BaseURL == "" {
		return nil, errors.New("cat-factory SDK: BaseURL is required")
	}
	if options.APIKey == "" {
		return nil, errors.New("cat-factory SDK: APIKey is required")
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	maxRetries := options.MaxRetries
	if maxRetries == 0 {
		maxRetries = 2
	}
	header := http.Header{}
	for key, values := range options.Header {
		header[key] = values
	}
	agent := ""
	if options.UserAgent != "" {
		agent = options.UserAgent + " "
	}
	header.Set("User-Agent", agent+"cat-factory-sdk-go/"+Version)

	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}

	client := &Client{
		baseURL:    strings.TrimRight(options.BaseURL, "/"),
		apiKey:     options.APIKey,
		timeout:    timeout,
		maxRetries: maxRetries,
		header:     header,
		httpClient: httpClient,
	}
	client.Jobs = &JobsService{client: client}
	client.Services = &ServicesService{client: client}
	client.Repos = &ReposService{client: client}
	client.Tasks = &TasksService{client: client}
	client.Pipelines = &PipelinesService{client: client}
	client.TaskTypes = &TaskTypesService{client: client}
	client.Notifications = &NotificationsService{client: client}
	client.Webhook = &WebhookService{client: client}
	client.Usage = &UsageService{client: client}
	client.Decisions = &DecisionsService{client: client}
	client.Debug = &DebugService{client: client}
	client.Me = &MeService{client: client}
	client.Evidence = &EvidenceService{client: client}
	client.Keys = &KeysService{client: client}
	return client, nil
}

// requestSpec is what a generated operation method describes and hands to the transport.
type requestSpec struct {
	Method string
	Path   string
	Body   any
	Query  map[string]string
}

// pathEscape percent-encodes a path parameter.
//
// An id is server-supplied but travels through a caller's own storage, and one carrying a "/"
// would otherwise re-target the request at a different route rather than 404 on the id it names.
func pathEscape(value string) string {
	return url.PathEscape(value)
}

// idempotent reports whether a method may be replayed after a failure.
//
// A transport failure with no response tells us nothing about whether the server acted, so only a
// method that is idempotent BY DEFINITION is replayed. POST /jobs and POST /tasks/:id/start
// both cost real LLM work, and a duplicate is not something the SDK may decide to risk on the
// caller's behalf.
func idempotent(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodDelete
}

func retriableStatus(status int) bool {
	return status == http.StatusTooManyRequests ||
		status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable ||
		status == http.StatusGatewayTimeout
}

// backoff applies full jitter on an exponential base, so a fleet of clients does not retry in
// lockstep.
func backoff(attempt int) time.Duration {
	ceiling := math.Min(8000, 250*math.Pow(2, float64(attempt)))
	return time.Duration(rand.Float64()*ceiling) * time.Millisecond
}

func (c *Client) buildRequest(ctx context.Context, spec requestSpec, accept string) (*http.Request, error) {
	target := c.baseURL + spec.Path
	if len(spec.Query) > 0 {
		values := url.Values{}
		for key, value := range spec.Query {
			// Absent values were already dropped by the generated `values()` helper; this guard
			// keeps a hand-built spec from producing `?limit=`.
			if value != "" {
				values.Set(key, value)
			}
		}
		if encoded := values.Encode(); encoded != "" {
			target += "?" + encoded
		}
	}

	var payload io.Reader
	if spec.Body != nil {
		encoded, err := json.Marshal(spec.Body)
		if err != nil {
			return nil, fmt.Errorf("cat-factory SDK: encoding the request body: %w", err)
		}
		payload = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, spec.Method, target, payload)
	if err != nil {
		return nil, fmt.Errorf("cat-factory SDK: building the request: %w", err)
	}
	for key, values := range c.header {
		request.Header[key] = values
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	if spec.Body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}

// responseKind is the shape of response an operation expects.
//
// It carries BOTH the Accept header and what the client Timeout bounds, because those two are one
// decision and splitting them is how they drift apart: an operation that asks for
// text/event-stream while the transport bounds the whole exchange gets a healthy run watch
// severed mid-flight, and nothing about either half looks wrong on its own.
type responseKind int

const (
	// unaryResponse is a single JSON body. Timeout bounds the WHOLE exchange, body included:
	// the body is bounded work, and a read that stalls forever is exactly what a deadline is for.
	unaryResponse responseKind = iota
	// streamResponse is a server-sent event stream. Timeout bounds only the wait for response
	// HEADERS — never the body, because here the body IS the stream, and a run being watched
	// legitimately outlives any per-request deadline by minutes. Bounding it cut every stream at
	// Timeout (30s by default) with `context deadline exceeded`, on a run that was fine.
	streamResponse
	// bytesResponse is an opaque binary body (an artifact download). Bounded like a unary
	// response: the body is finite and its exact size was known to the caller before it asked,
	// because the listing that handed out the id carries each artifact's byteSize.
	bytesResponse
)

func (k responseKind) accept() string {
	switch k {
	case streamResponse:
		return "text/event-stream"
	case bytesResponse:
		// The endpoint declares SEVERAL media types (the image allow-list plus an
		// application/octet-stream fallback) and answers with whichever one the stored artifact
		// is, so naming any single one would disagree with most of what it sends.
		return "*/*"
	default:
		return "application/json"
	}
}

// attemptDeadline applies the client Timeout at the scope the responseKind calls for.
//
// The streaming case cannot be a context.WithTimeout: that deadline keeps running over the body,
// which is the bug it exists to avoid. So it is a cancellable context plus a timer that is
// STOPPED the moment headers arrive — the same shape as the TypeScript SDK clearing its abort
// timer once fetch resolves, and as the JDK's own HttpRequest.timeout, so all four SDKs mean the
// same thing by "timeout" on a stream.
type attemptDeadline struct {
	ctx    context.Context
	cancel context.CancelCauseFunc
	timer  *time.Timer
	// Whether arriving headers release the deadline (a stream) or it keeps running over the
	// body (a unary response).
	stopOnHeaders bool
}

func (c *Client) startAttempt(ctx context.Context, kind responseKind) *attemptDeadline {
	attemptCtx, cancel := context.WithCancelCause(ctx)
	deadline := &attemptDeadline{ctx: attemptCtx, cancel: cancel}
	// Cancel with DeadlineExceeded as the CAUSE, so an expiry stays distinguishable from a
	// caller's cancellation after the fact — which is what lets the error below be classified as
	// a timeout rather than collapsing into a generic connection failure.
	deadline.timer = time.AfterFunc(c.timeout, func() { cancel(context.DeadlineExceeded) })
	if kind != streamResponse {
		return deadline
	}
	deadline.stopOnHeaders = true
	return deadline
}

// headersReceived releases a stream's deadline. A no-op for a unary attempt, whose deadline is
// meant to keep running over the body.
func (d *attemptDeadline) headersReceived() {
	if d.stopOnHeaders {
		d.timer.Stop()
	}
}

// release ends the attempt, stopping the timer so it cannot fire against a reused connection.
func (d *attemptDeadline) release() {
	d.timer.Stop()
	d.cancel(context.Canceled)
}

// expired reports whether OUR deadline is what ended the attempt, as opposed to the caller's own
// cancellation or a genuine transport fault. They need different reactions — a longer budget can
// fix the first and cannot fix the third — so they must not collapse into one error.
func (d *attemptDeadline) expired() bool {
	return errors.Is(context.Cause(d.ctx), context.DeadlineExceeded)
}

// do performs the request with the retry policy, returning the raw response for the caller to
// consume. The caller owns closing the body.
func (c *Client) do(ctx context.Context, spec requestSpec, kind responseKind, retries int) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		deadline := c.startAttempt(ctx, kind)
		request, err := c.buildRequest(deadline.ctx, spec, kind.accept())
		if err != nil {
			deadline.release()
			return nil, err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			timedOut := deadline.expired()
			deadline.release()
			// The CALLER's cancellation is not a transport fault and must not be retried or
			// re-wrapped as one — it is the outcome they asked for.
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if attempt < retries && idempotent(spec.Method) {
				if sleepErr := sleep(ctx, backoff(attempt)); sleepErr != nil {
					return nil, sleepErr
				}
				continue
			}
			if timedOut {
				return nil, &TimeoutError{Method: spec.Method, Path: spec.Path, Timeout: c.timeout}
			}
			return nil, &ConnectionError{Method: spec.Method, Path: spec.Path, Err: err}
		}
		if response.StatusCode < 400 {
			// Headers are in, so a stream's deadline is done: what follows is the stream itself.
			deadline.headersReceived()
			// The response body outlives this function, so the per-attempt context must NOT be
			// cancelled here — doing so kills the stream the caller is about to read. Tie the
			// cancel to the body instead, so it fires exactly when the caller closes it.
			response.Body = &cancellingBody{ReadCloser: response.Body, release: deadline.release}
			return response, nil
		}

		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		retryAfter, hasRetryAfter := parseRetryAfter(response.Header.Get("Retry-After"))
		_ = response.Body.Close()
		deadline.release()

		if attempt < retries && idempotent(spec.Method) && retriableStatus(response.StatusCode) {
			wait := backoff(attempt)
			if hasRetryAfter {
				// The deployment's own knowledge of when the limit clears beats a blind curve.
				wait = retryAfter
			}
			if sleepErr := sleep(ctx, wait); sleepErr != nil {
				return nil, sleepErr
			}
			continue
		}
		return nil, toAPIError(response.StatusCode, body, response.Header.Get("X-Request-Id"))
	}
}

// cancellingBody ties a response body's lifetime to its attempt, so the attempt is released
// exactly when the caller closes the body rather than being leaked or, worse, cancelled while the
// body is still being read (which is what would kill an SSE stream the moment it was handed over).
type cancellingBody struct {
	io.ReadCloser
	release func()
}

func (b *cancellingBody) Close() error {
	err := b.ReadCloser.Close()
	b.release()
	return err
}

// request performs a request and decodes its JSON body into out.
func (c *Client) request(ctx context.Context, spec requestSpec, out any) error {
	response, err := c.do(ctx, spec, unaryResponse, c.maxRetries)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return &ConnectionError{Method: spec.Method, Path: spec.Path, Err: err}
	}
	if len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &DecodeError{Method: spec.Method, Path: spec.Path, RawBody: string(body), Err: err}
	}
	return nil
}

// requestNoContent performs a request whose success carries no body (a 204).
func (c *Client) requestNoContent(ctx context.Context, spec requestSpec) error {
	response, err := c.do(ctx, spec, unaryResponse, c.maxRetries)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	// Drain, so the connection returns to the pool rather than being dropped.
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}

// requestBytes performs a request whose success carries BYTES rather than JSON.
//
// Read whole rather than handed back as a ReadCloser: the listing endpoint that hands out these
// ids also carries each artifact's exact byteSize, so a caller decides whether to fetch before
// issuing the request, and returning an open body would push lifetime management onto every
// caller for no gain.
func (c *Client) requestBytes(ctx context.Context, spec requestSpec) ([]byte, error) {
	response, err := c.do(ctx, spec, bytesResponse, c.maxRetries)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, &ConnectionError{Method: spec.Method, Path: spec.Path, Err: err}
	}
	return body, nil
}

// stream opens a server-sent event stream.
//
// Deliberately NOT retried: a reconnect would replay the stream from its start, and the caller —
// who knows which events it has already acted on — is the only party that can decide whether that
// is safe.
func (c *Client) stream(ctx context.Context, spec requestSpec) (*EventStream, error) {
	response, err := c.do(ctx, spec, streamResponse, 0)
	if err != nil {
		return nil, err
	}
	return newEventStream(response.Body), nil
}

// sleep waits, but wakes early (with an error) if the caller's context is cancelled — so a
// cancelled call does not sit through a backoff before noticing.
func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// parseRetryAfter reads a Retry-After header, capped at a minute.
//
// Both wire forms RFC 9110 allows: delta-seconds, and an HTTP-date, which a proxy or CDN in front
// of the deployment routinely writes instead. Reading only the numeric form silently discarded the
// deployment's own knowledge of when the limit clears and fell back to a blind backoff curve —
// which still works, just worse, so nothing would ever have surfaced it.
func parseRetryAfter(header string) (time.Duration, bool) {
	header = strings.TrimSpace(header)
	if header == "" {
		return 0, false
	}
	if seconds, err := strconv.Atoi(header); err == nil {
		if seconds < 0 {
			return 0, false
		}
		return min(time.Duration(seconds)*time.Second, time.Minute), true
	}
	at, err := http.ParseTime(header)
	if err != nil {
		return 0, false
	}
	return max(0, min(time.Until(at), time.Minute)), true
}
