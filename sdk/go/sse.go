// Hand-written (NOT generated): the server-sent-events reader for the two streaming endpoints.
//
// The framing rules implemented here are the ones a naive split on blank lines gets wrong, and
// getting them wrong shows up as a run that silently appears to stall:
//
//   - A read boundary can fall anywhere, so records are assembled line by line rather than from
//     whole chunks.
//   - A record may carry several data: lines; per the spec they join with "\n". Taking only the
//     last would silently truncate a multi-line run projection.
//   - A record left unterminated when the socket closes is still a record the server sent.
//     Dropping it would lose exactly the terminal done frame in the case where the server closes
//     the connection in the same breath as emitting it.
//   - The stream ends in one of three ways the caller must tell apart: a terminal done/error
//     event, a timeout event when the deployment's connection cap is reached, or the socket simply
//     closing. Only the first is the run reaching a verdict; treating a cap or a dropped socket as
//     "finished" is how a poller concludes a running job succeeded.

package catfactory

import (
	"bufio"
	"encoding/json"
	"io"
	"iter"
	"strings"
)

// StreamEvent is one decoded SSE record.
type StreamEvent struct {
	// Event is the event: field, or "message" when the server sent none (the SSE default).
	Event string
	// Data is the joined data: payload, verbatim.
	Data string
	// ID is the id: field, when the server sent one.
	ID string
}

// JSON decodes Data into out. It reports an error for a frame that is not JSON, which a caller
// should treat as "skip" rather than "fail": a keep-alive arriving mid-stream is normal.
func (e StreamEvent) JSON(out any) error {
	return json.Unmarshal([]byte(e.Data), out)
}

// EventStream is a stream of server-sent events.
//
// Always Close it — with defer, or by ranging to completion — so the socket is released rather
// than held against the deployment's per-connection cap.
type EventStream struct {
	body   io.ReadCloser
	reader *bufio.Reader
	err    error
	closed bool
}

func newEventStream(body io.ReadCloser) *EventStream {
	return &EventStream{body: body, reader: bufio.NewReader(body)}
}

// Events yields each event as it arrives.
//
//	stream, err := client.Tasks.Stream(ctx, taskID)
//	if err != nil { return err }
//	defer stream.Close()
//	for event := range stream.Events() {
//		if event.Event == "done" || event.Event == "error" { break }
//	}
//	if err := stream.Err(); err != nil { return err }
//
// Check Err after the loop: a stream that ended because the socket dropped is NOT the same as one
// that ended on a terminal event, and only Err tells them apart.
func (s *EventStream) Events() iter.Seq[StreamEvent] {
	return func(yield func(StreamEvent) bool) {
		var record []string
		for {
			line, err := s.reader.ReadString('\n')
			if len(line) > 0 {
				trimmed := strings.TrimRight(line, "\r\n")
				if trimmed == "" {
					if event, ok := decodeEvent(record); ok && !yield(event) {
						return
					}
					record = record[:0]
				} else {
					record = append(record, trimmed)
				}
			}
			if err != nil {
				if err != io.EOF {
					s.err = err
				}
				// Trailing, unterminated record — see the file note.
				if event, ok := decodeEvent(record); ok {
					yield(event)
				}
				return
			}
		}
	}
}

// Err reports why the stream ended, or nil when it ended cleanly (EOF).
func (s *EventStream) Err() error { return s.err }

// Close releases the socket. Safe to call more than once.
func (s *EventStream) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	return s.body.Close()
}

func decodeEvent(lines []string) (StreamEvent, bool) {
	event := StreamEvent{Event: "message"}
	var data []string
	for _, line := range lines {
		// A leading colon is a comment — servers send them as keep-alives. Never a record.
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, raw, found := strings.Cut(line, ":")
		if !found {
			raw = ""
		}
		// One optional leading space after the colon is framing, not value.
		value := strings.TrimPrefix(raw, " ")
		switch field {
		case "event":
			event.Event = value
		case "data":
			data = append(data, value)
		case "id":
			event.ID = value
		}
	}
	if len(data) == 0 && event.Event == "message" {
		return StreamEvent{}, false
	}
	event.Data = strings.Join(data, "\n")
	return event, true
}
