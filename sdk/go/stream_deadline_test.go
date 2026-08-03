// What the client Timeout bounds, per response kind.
//
// This is the one property of the transport the cross-SDK smoketest structurally cannot check: its
// scenario finishes in seconds with the agent side faked, so a stream severed at the 30s default
// looks identical to one that ran to completion. It surfaces only against a real run — as a watch
// that dies after half a minute on a job that was perfectly healthy — which is why it is pinned
// here, in wall-clock, rather than left to the harness.

package catfactory

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A stream must outlive the client Timeout: the deadline covers the wait for response headers,
// and the body IS the stream.
func TestStreamOutlivesClientTimeout(t *testing.T) {
	const frames = 8
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for i := range frames {
			fmt.Fprintf(w, "event: progress\ndata: {\"n\":%d}\n\n", i)
			w.(http.Flusher).Flush()
			time.Sleep(40 * time.Millisecond)
		}
	}))
	defer server.Close()

	// A Timeout far SHORTER than the stream's own life, standing in for the shipped 30s default
	// against a run that takes minutes.
	client, err := New(Options{BaseURL: server.URL, APIKey: "k", Timeout: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.stream(context.Background(), requestSpec{Method: http.MethodGet, Path: "/events"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	received := 0
	for range stream.Events() {
		received++
	}
	if streamErr := stream.Err(); streamErr != nil {
		t.Fatalf("stream ended with %v; the client deadline must not run over the body", streamErr)
	}
	if received != frames {
		t.Fatalf("received %d of %d frames — the stream was cut short by the client Timeout", received, frames)
	}
}

// The caller's own context still bounds a stream: releasing the per-request deadline must not
// leave a stream nothing can stop.
func TestStreamStillHonoursCallerContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-request.Context().Done()
	}))
	defer server.Close()

	client, err := New(Options{BaseURL: server.URL, APIKey: "k", Timeout: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	stream, err := client.stream(ctx, requestSpec{Method: http.MethodGet, Path: "/events"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	done := make(chan struct{})
	go func() {
		for range stream.Events() {
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelling the caller's context did not end the stream")
	}
}

// A unary request keeps the deadline over its BODY: that body is bounded work, and a response that
// stalls mid-read is exactly what the deadline is for.
func TestUnaryRequestDeadlineCoversTheBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "64")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-request.Context().Done() // never finish the body
	}))
	defer server.Close()

	client, err := New(Options{BaseURL: server.URL, APIKey: "k", Timeout: 120 * time.Millisecond, MaxRetries: 1})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	err = client.request(context.Background(), requestSpec{Method: http.MethodGet, Path: "/thing"}, &out)
	if err == nil {
		t.Fatal("expected the stalled body read to fail")
	}
}

// A timeout and a connection failure are DIFFERENT errors, because they need different reactions.
func TestTimeoutIsItsOwnErrorType(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		<-request.Context().Done() // never send headers
	}))
	defer server.Close()

	client, err := New(Options{BaseURL: server.URL, APIKey: "k", Timeout: 80 * time.Millisecond, MaxRetries: 1})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	err = client.request(context.Background(), requestSpec{Method: http.MethodGet, Path: "/thing"}, &out)
	if !IsTimeout(err) {
		t.Fatalf("expected a *TimeoutError, got %#v", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Error("a TimeoutError should satisfy errors.Is(err, context.DeadlineExceeded)")
	}
	var connErr *ConnectionError
	if errors.As(err, &connErr) {
		t.Error("a timeout must not also present as a ConnectionError")
	}
}

// A refused connection is a ConnectionError, not a timeout — the other half of the same split.
func TestUnreachableDeploymentIsAConnectionError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := server.URL
	server.Close() // nothing is listening now

	client, err := New(Options{BaseURL: base, APIKey: "k", Timeout: 2 * time.Second, MaxRetries: 0})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	err = client.request(context.Background(), requestSpec{Method: http.MethodGet, Path: "/thing"}, &out)
	var connErr *ConnectionError
	if !errors.As(err, &connErr) {
		t.Fatalf("expected a *ConnectionError, got %#v", err)
	}
	if IsTimeout(err) {
		t.Error("a refused connection must not present as a timeout")
	}
}
