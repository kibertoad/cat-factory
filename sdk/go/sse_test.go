// The SSE reader's framing rules.
//
// The cross-SDK smoketest proves the stream works end to end, but it cannot provoke the cases that
// actually bite — a read boundary landing mid-record, a multi-line payload, a terminal frame
// arriving in the same breath as the socket closing. Each of those shows up in production as a run
// that silently appears to stall, so each gets a test that constructs the byte sequence directly.
//
// The other SDKs have mirrors of this file. The four readers are independent implementations of one
// wire format, so they need independent tests — the smoketest compares what they observed, not how
// they framed it.

package catfactory

import (
	"io"
	"strings"
	"testing"
)

// closeTracker records whether the body was released.
type closeTracker struct {
	io.Reader
	closed bool
}

func (c *closeTracker) Close() error {
	c.closed = true
	return nil
}

func collect(t *testing.T, body string) ([]StreamEvent, *EventStream) {
	t.Helper()
	stream := newEventStream(&closeTracker{Reader: strings.NewReader(body)})
	var events []StreamEvent
	for event := range stream.Events() {
		events = append(events, event)
	}
	return events, stream
}

func names(events []StreamEvent) []string {
	out := make([]string, 0, len(events))
	for _, event := range events {
		out = append(out, event.Event)
	}
	return out
}

func TestDecodesARecord(t *testing.T) {
	events, _ := collect(t, "event: progress\ndata: {\"runId\":\"r1\"}\n\n")
	if len(events) != 1 || events[0].Event != "progress" {
		t.Fatalf("expected one progress event, got %v", names(events))
	}
	var payload struct {
		RunID string `json:"runId"`
	}
	if err := events[0].JSON(&payload); err != nil || payload.RunID != "r1" {
		t.Fatalf("payload = %+v, err = %v", payload, err)
	}
}

func TestJoinsDataLines(t *testing.T) {
	// Per the SSE spec. Taking only the last line would silently truncate a payload.
	events, _ := collect(t, "event: progress\ndata: line one\ndata: line two\n\n")
	if events[0].Data != "line one\nline two" {
		t.Fatalf("data = %q", events[0].Data)
	}
}

func TestYieldsUnterminatedTrailingRecord(t *testing.T) {
	// The case that matters: a server closing the connection in the same breath as its terminal
	// frame. Dropping the unterminated record loses exactly the `done` the caller waits for.
	events, _ := collect(t, "event: progress\ndata: {}\n\nevent: done\ndata: {\"ok\":true}\n")
	got := names(events)
	if len(got) != 2 || got[0] != "progress" || got[1] != "done" {
		t.Fatalf("events = %v", got)
	}
}

func TestIgnoresKeepAlives(t *testing.T) {
	// Servers send `:` lines to hold the connection open. Treating one as a record would hand the
	// caller a phantom event on a perfectly healthy stream.
	events, _ := collect(t, ": keep-alive\n\nevent: done\ndata: {}\n\n")
	if got := names(events); len(got) != 1 || got[0] != "done" {
		t.Fatalf("events = %v", got)
	}
}

func TestAcceptsCRLF(t *testing.T) {
	// A proxy that normalizes line endings would otherwise make the stream appear to emit nothing
	// at all, because no complete record would ever be recognised.
	events, _ := collect(t, "event: progress\r\ndata: {\"a\":1}\r\n\r\n")
	if len(events) != 1 || events[0].Event != "progress" {
		t.Fatalf("events = %v", names(events))
	}
}

func TestStripsOneLeadingSpace(t *testing.T) {
	// The single space is framing; a second one is payload.
	events, _ := collect(t, "event: progress\ndata:  padded\n\n")
	if events[0].Data != " padded" {
		t.Fatalf("data = %q", events[0].Data)
	}
}

func TestDefaultsEventName(t *testing.T) {
	events, _ := collect(t, "data: {\"a\":1}\n\n")
	if events[0].Event != "message" {
		t.Fatalf("event = %q", events[0].Event)
	}
}

func TestJSONReportsNonJSON(t *testing.T) {
	// The caller should treat this as "skip", not "fail": a keep-alive mid-stream is normal.
	events, _ := collect(t, "event: progress\ndata: not json\n\n")
	var out map[string]any
	if err := events[0].JSON(&out); err == nil {
		t.Fatal("expected a decode error for a non-JSON payload")
	}
}

func TestCloseReleasesTheBody(t *testing.T) {
	tracker := &closeTracker{Reader: strings.NewReader("event: progress\ndata: {}\n\n")}
	stream := newEventStream(tracker)
	for range stream.Events() {
		break
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if !tracker.closed {
		t.Fatal("the SDK must release the socket rather than hold it open")
	}
}

func TestErrIsNilOnCleanEOF(t *testing.T) {
	// A stream that ended because the socket dropped is NOT the same as one that ended on a
	// terminal event, and Err is the only thing that tells them apart.
	_, stream := collect(t, "event: done\ndata: {}\n\n")
	if err := stream.Err(); err != nil {
		t.Fatalf("Err = %v, want nil for a clean EOF", err)
	}
}
