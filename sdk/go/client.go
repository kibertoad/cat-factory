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
const Version = "0.1.0"

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
	// Initiatives.Create replayable.
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

	// Headless initiative-breakdown runs.
	Initiatives *InitiativesService
	// The workspace's board services.
	Services *ServicesService
	// Board tasks: create, edit, start, stop, retry, watch, delete.
	Tasks *TasksService
	// The pipelines a task can be started with.
	Pipelines *PipelinesService
	// The workspace's human-actionable inbox.
	Notifications *NotificationsService
	// The period's metered budget position and per-model breakdown.
	Usage *UsageService
	// A parked run's human decisions.
	Decisions *DecisionsService
	// A run's recorded telemetry, for diagnosing one that went wrong.
	Debug *DebugService
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
	client.Initiatives = &InitiativesService{client: client}
	client.Services = &ServicesService{client: client}
	client.Tasks = &TasksService{client: client}
	client.Pipelines = &PipelinesService{client: client}
	client.Notifications = &NotificationsService{client: client}
	client.Usage = &UsageService{client: client}
	client.Decisions = &DecisionsService{client: client}
	client.Debug = &DebugService{client: client}
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
// method that is idempotent BY DEFINITION is replayed. POST /initiatives and POST /tasks/:id/start
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

// do performs the request with the retry policy, returning the raw response for the caller to
// consume. The caller owns closing the body.
func (c *Client) do(ctx context.Context, spec requestSpec, accept string, retries int) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		// A per-attempt deadline, composed with the caller's context so cancelling ctx still wins.
		attemptCtx, cancel := context.WithTimeout(ctx, c.timeout)
		request, err := c.buildRequest(attemptCtx, spec, accept)
		if err != nil {
			cancel()
			return nil, err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			cancel()
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
			return nil, &ConnectionError{Method: spec.Method, Path: spec.Path, Err: err}
		}
		if response.StatusCode < 400 {
			// The response body outlives this function, so the per-attempt context must NOT be
			// cancelled here — doing so kills the stream the caller is about to read. Tie the
			// cancel to the body instead, so it fires exactly when the caller closes it.
			response.Body = &cancellingBody{ReadCloser: response.Body, cancel: cancel}
			return response, nil
		}

		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		retryAfter, hasRetryAfter := parseRetryAfter(response.Header.Get("Retry-After"))
		_ = response.Body.Close()
		cancel()

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

// cancellingBody ties a response body's lifetime to its per-attempt context cancel func, so the
// context is released exactly when the caller closes the body rather than being leaked or, worse,
// cancelled while the body is still being read (which is what would kill an SSE stream the moment
// it was handed over).
type cancellingBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancellingBody) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

// request performs a request and decodes its JSON body into out.
func (c *Client) request(ctx context.Context, spec requestSpec, out any) error {
	response, err := c.do(ctx, spec, "application/json", c.maxRetries)
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
	response, err := c.do(ctx, spec, "application/json", c.maxRetries)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	// Drain, so the connection returns to the pool rather than being dropped.
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}

// stream opens a server-sent event stream.
//
// Deliberately NOT retried: a reconnect would replay the stream from its start, and the caller —
// who knows which events it has already acted on — is the only party that can decide whether that
// is safe.
func (c *Client) stream(ctx context.Context, spec requestSpec) (*EventStream, error) {
	response, err := c.do(ctx, spec, "text/event-stream", 0)
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

// parseRetryAfter reads a Retry-After header in seconds, capped at a minute.
func parseRetryAfter(header string) (time.Duration, bool) {
	if header == "" {
		return 0, false
	}
	seconds, err := strconv.Atoi(strings.TrimSpace(header))
	if err != nil || seconds < 0 {
		return 0, false
	}
	wait := time.Duration(seconds) * time.Second
	if wait > time.Minute {
		wait = time.Minute
	}
	return wait, true
}
