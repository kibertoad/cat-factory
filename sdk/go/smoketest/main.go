// The Go SDK's smoketest program.
//
// One of four programs — one per SDK — that drive the SAME scenario against a live deployment and
// write the SAME observation report. The harness (backend/internal/sdk-smoketest) boots a real
// backend, runs all four, and then compares their reports field by field.
//
// That comparison is the point. A per-SDK test can only assert that ITS OWN client agrees with
// what its author expected; four reports compared against each other catch the class of bug this
// SDK family is most exposed to — one language decoding a field differently, mapping an error to
// the wrong class, dropping a null, or paginating one page short — because those show up as a
// DISAGREEMENT even when nobody wrote down what the right answer was.
//
// So the rule for this file: OBSERVE and RECORD, do not assert.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	catfactory "github.com/kibertoad/cat-factory/sdk/go"
)

var (
	terminalSSE  = map[string]bool{"done": true, "error": true, "timeout": true}
	knownSSE     = map[string]bool{"progress": true, "done": true, "error": true, "decision": true, "timeout": true}
	knownRunStat = map[string]bool{"running": true, "blocked": true, "paused": true, "done": true, "failed": true}
)

type report struct {
	SDK          string         `json:"sdk"`
	SDKVersion   string         `json:"sdkVersion"`
	Observations map[string]any `json:"observations"`
	Failures     []string       `json:"failures"`
}

func requireEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		fmt.Fprintf(os.Stderr, "smoketest: %s is required\n", name)
		os.Exit(2)
	}
	return value
}

func main() {
	baseURL := requireEnv("CAT_FACTORY_BASE_URL")
	apiKey := requireEnv("CAT_FACTORY_API_KEY")
	readKey := requireEnv("CAT_FACTORY_READ_KEY")
	outPath := requireEnv("CAT_FACTORY_SMOKETEST_OUT")

	observations := map[string]any{}
	var failures []string

	// Run one scenario step, recording a failure rather than aborting the rest of the run.
	step := func(name string, fn func() error) {
		if err := fn(); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", name, err))
		}
	}

	ctx := context.Background()
	client, err := catfactory.New(catfactory.Options{
		BaseURL: baseURL, APIKey: apiKey, UserAgent: "cat-factory-smoketest",
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	readClient, err := catfactory.New(catfactory.Options{BaseURL: baseURL, APIKey: readKey})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	var serviceID, taskID, pipelineID string

	step("services.list", func() error {
		result, err := client.Services.List(ctx)
		if err != nil {
			return err
		}
		observations["serviceCount"] = len(result.Services)
		if len(result.Services) > 0 {
			serviceID = result.Services[0].ServiceID
		}
		observations["firstServiceHasId"] = serviceID != ""
		return nil
	})

	step("pipelines.list", func() error {
		result, err := client.Pipelines.List(ctx)
		if err != nil {
			return err
		}
		observations["pipelineCount"] = len(result.Pipelines)
		startable := 0
		publicCount := 0
		for _, pipeline := range result.Pipelines {
			if pipeline.HeadlessStartable {
				if startable == 0 {
					pipelineID = pipeline.PipelineID
				}
				startable++
			}
			// `public` is a keyword in Java and Kotlin; reading it here keeps the four SDKs
			// comparable on the field whose NAME differs between them (`isPublic()` on the JVM).
			if pipeline.Public {
				publicCount++
			}
		}
		observations["headlessStartableCount"] = startable
		observations["publicPipelineCount"] = publicCount
		return nil
	})

	step("tasks.create", func() error {
		description := "Created by the cross-SDK smoketest."
		taskType := "feature"
		task, err := client.Tasks.Create(ctx, serviceID, catfactory.CreatePublicTask{
			Title:       "SDK smoketest task",
			Description: &description,
			TaskType:    &taskType,
		})
		if err != nil {
			return err
		}
		taskID = task.TaskID
		observations["createdStatus"] = string(task.Status)
		observations["createdTaskType"] = task.TaskType
		// A required-but-NULLABLE field: the server always sends it, and it is null here.
		// Recording it explicitly is what proves the four SDKs agree that "the server said null"
		// and "the server said nothing" are different facts.
		observations["createdRunIdIsNull"] = task.RunID == nil
		observations["createdPullRequestUrlIsNull"] = task.PullRequestURL == nil
		return nil
	})

	step("tasks.update", func() error {
		title := "SDK smoketest task (edited)"
		task, err := client.Tasks.Update(ctx, taskID, catfactory.UpdatePublicTask{Title: &title})
		if err != nil {
			return err
		}
		observations["updatedTitle"] = task.Title
		return nil
	})

	step("tasks.get", func() error {
		task, err := client.Tasks.Get(ctx, taskID)
		if err != nil {
			return err
		}
		observations["fetchedTitle"] = task.Title
		observations["fetchedStatus"] = string(task.Status)
		return nil
	})

	step("tasks.listByService (one page)", func() error {
		limit := 1
		page, err := client.Tasks.ListByService(ctx, serviceID, &catfactory.TasksListByServiceQuery{Limit: &limit})
		if err != nil {
			return err
		}
		observations["pageSize"] = len(page.Tasks)
		observations["pageHasCursor"] = page.NextCursor != nil
		return nil
	})

	step("tasks.listByServiceAll (auto-paging)", func() error {
		limit := 1
		var seen []string
		unique := map[string]bool{}
		for task, err := range client.Tasks.ListByServiceAll(ctx, serviceID, &catfactory.TasksListByServiceQuery{Limit: &limit}) {
			if err != nil {
				return err
			}
			seen = append(seen, task.TaskID)
			unique[task.TaskID] = true
		}
		observations["pagedTaskCount"] = len(seen)
		contains := false
		for _, id := range seen {
			if id == taskID {
				contains = true
			}
		}
		observations["pagedContainsCreated"] = contains
		// A duplicate would mean the cursor was not advancing — the classic keyset paging bug,
		// and one a single-page test never sees.
		observations["pagedHasDuplicates"] = len(unique) != len(seen)
		return nil
	})

	step("usage.get", func() error {
		usage, err := client.Usage.Get(ctx)
		if err != nil {
			return err
		}
		observations["usageCurrency"] = usage.Currency
		observations["usageBudgetExceeded"] = usage.Budget.Exceeded
		observations["usageRowsIsArray"] = usage.Rows != nil
		return nil
	})

	step("notifications.list", func() error {
		result, err := client.Notifications.List(ctx)
		if err != nil {
			return err
		}
		observations["notificationCount"] = len(result.Notifications)
		return nil
	})

	step("error: not found", func() error {
		_, err := client.Tasks.Get(ctx, "blk_definitely_not_a_real_task")
		if err == nil {
			return fmt.Errorf("expected a 404, got a success")
		}
		observations["notFoundIsTypedClass"] = catfactory.IsNotFound(err)
		var apiErr *catfactory.APIError
		if asAPIError(err, &apiErr) {
			observations["notFoundStatus"] = apiErr.Status
			observations["notFoundCode"] = apiErr.Code
			observations["notFoundHasRequestId"] = apiErr.RequestID != ""
		}
		return nil
	})

	step("error: unauthorized", func() error {
		bogus, err := catfactory.New(catfactory.Options{BaseURL: baseURL, APIKey: "cf_live_pak_0000.deadbeef"})
		if err != nil {
			return err
		}
		_, err = bogus.Services.List(ctx)
		if err == nil {
			return fmt.Errorf("expected a 401, got a success")
		}
		observations["unauthorizedIsTypedClass"] = catfactory.IsUnauthorized(err)
		var apiErr *catfactory.APIError
		if asAPIError(err, &apiErr) {
			observations["unauthorizedStatus"] = apiErr.Status
		}
		return nil
	})

	step("error: insufficient scope", func() error {
		// A `read` key may list, but never create. The refusal carries a SURFACE-specific code
		// (`insufficient_scope`) rather than a status-class one, which is exactly the case the
		// SDKs deliberately do not narrow to an enum — so all four must surface it verbatim.
		_, err := readClient.Tasks.Create(ctx, serviceID, catfactory.CreatePublicTask{Title: "should be refused"})
		if err == nil {
			return fmt.Errorf("expected a 403, got a success")
		}
		observations["forbiddenIsTypedClass"] = catfactory.IsForbidden(err)
		var apiErr *catfactory.APIError
		if asAPIError(err, &apiErr) {
			observations["forbiddenStatus"] = apiErr.Status
			observations["forbiddenCode"] = apiErr.Code
		}
		return nil
	})

	step("tasks.start", func() error {
		body := catfactory.StartPublicTask{}
		if pipelineID != "" {
			body.PipelineID = &pipelineID
		}
		task, err := client.Tasks.Start(ctx, taskID, body)
		if err != nil {
			return err
		}
		observations["startedStatus"] = string(task.Status)
		observations["startedHasRunId"] = task.RunID != nil
		return nil
	})

	step("tasks.stream (SSE)", func() error {
		streamCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		stream, err := client.Tasks.Stream(streamCtx, taskID)
		if err != nil {
			return err
		}
		defer stream.Close()
		var events []string
		allKnown := true
		for event := range stream.Events() {
			events = append(events, event.Event)
			if !knownSSE[event.Event] {
				allKnown = false
			}
			// The run's own terminal frames, plus the deployment's connection cap. Stopping at a
			// fixed count as well keeps the smoketest bounded when a run parks on a human
			// decision — which is a legitimate outcome, not a failure.
			if terminalSSE[event.Event] || len(events) >= 3 {
				break
			}
		}
		observations["sseEventCount"] = len(events)
		if len(events) > 0 {
			observations["sseFirstEvent"] = events[0]
		} else {
			observations["sseFirstEvent"] = nil
		}
		observations["sseFramesAreKnown"] = allKnown
		return stream.Err()
	})

	step("tasks.getRun", func() error {
		run, err := client.Tasks.GetRun(ctx, taskID)
		if err != nil {
			return err
		}
		observations["runHasSteps"] = len(run.Steps) > 0
		observations["runStatusIsKnown"] = knownRunStat[string(run.Status)]
		return nil
	})

	step("tasks.stop", func() error {
		task, err := client.Tasks.Stop(ctx, taskID)
		if err != nil {
			return err
		}
		observations["stoppedStatus"] = string(task.Status)
		return nil
	})

	step("tasks.delete", func() error {
		if err := client.Tasks.Delete(ctx, taskID); err != nil {
			return err
		}
		_, err := client.Tasks.Get(ctx, taskID)
		observations["deletedThenGone"] = catfactory.IsNotFound(err)
		if err == nil {
			return fmt.Errorf("the task was still readable after deletion")
		}
		return nil
	})

	if failures == nil {
		failures = []string{}
	}
	encoded, err := json.MarshalIndent(report{
		SDK: "go", SDKVersion: catfactory.Version, Observations: observations, Failures: failures,
	}, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := os.WriteFile(outPath, append(encoded, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	if len(failures) > 0 {
		fmt.Fprintf(os.Stderr, "go smoketest recorded %d failure(s):\n", len(failures))
		for _, failure := range failures {
			fmt.Fprintf(os.Stderr, "  - %s\n", failure)
		}
		os.Exit(1)
	}
	fmt.Println("go smoketest completed")
}

// asAPIError is errors.As specialised to *APIError, kept as a helper so each step reads as one
// line rather than repeating the ceremony.
func asAPIError(err error, target **catfactory.APIError) bool {
	return errors.As(err, target)
}
