// The Java SDK's smoketest program.
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
//
// It lives OUTSIDE src/main and src/test on purpose: it is neither part of the published jar nor a
// unit test, and putting it in src/test would make `mvn test` try to run it with no deployment to
// talk to. The harness compiles it against the built classes explicitly.

package ai.catfactory.sdk.smoketest;

import ai.catfactory.sdk.CatFactoryClient;
import ai.catfactory.sdk.CatFactoryApiException;
import ai.catfactory.sdk.CatFactoryConnectionException;
import ai.catfactory.sdk.CatFactoryForbiddenException;
import ai.catfactory.sdk.CatFactoryNotFoundException;
import ai.catfactory.sdk.CatFactoryUnauthorizedException;
import ai.catfactory.sdk.EventStream;
import ai.catfactory.sdk.StreamEvent;
import ai.catfactory.sdk.Transport;
import ai.catfactory.sdk.model.CreatePublicTask;
import ai.catfactory.sdk.model.ListPublicTaskTypesResponseTaskTypeField;
import ai.catfactory.sdk.model.NotificationWebhook;
import ai.catfactory.sdk.model.NotificationWebhookAlertEvent;
import ai.catfactory.sdk.model.NotificationWebhookRunEvent;
import ai.catfactory.sdk.model.PublicNotificationWebhook;
import ai.catfactory.sdk.model.PutNotificationWebhook;
import ai.catfactory.sdk.model.PublicPipeline;
import ai.catfactory.sdk.model.PublicRun;
import ai.catfactory.sdk.model.PublicTask;
import ai.catfactory.sdk.model.PublicUsage;
import ai.catfactory.sdk.model.StartPublicTask;
import ai.catfactory.sdk.model.TasksListByServiceQuery;
import ai.catfactory.sdk.model.UpdatePublicTask;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class Smoketest {

    private static final Set<String> TERMINAL_SSE = Set.of("done", "error", "timeout");
    private static final Set<String> KNOWN_SSE =
            Set.of("progress", "done", "error", "decision", "timeout");
    private static final Set<String> KNOWN_RUN_STATUSES =
            Set.of("running", "blocked", "paused", "done", "failed");

    private final Map<String, Object> observations = new LinkedHashMap<>();
    private final List<String> failures = new ArrayList<>();

    private String serviceId = "";
    private String taskId = "";
    private String pipelineId = "";

    public static void main(String[] args) throws Exception {
        String baseUrl = requireEnv("CAT_FACTORY_BASE_URL");
        String apiKey = requireEnv("CAT_FACTORY_API_KEY");
        String readKey = requireEnv("CAT_FACTORY_READ_KEY");
        String deadUrl = requireEnv("CAT_FACTORY_SMOKETEST_DEAD_URL");
        Path out = Path.of(requireEnv("CAT_FACTORY_SMOKETEST_OUT"));

        Smoketest smoketest = new Smoketest();
        CatFactoryClient client =
                CatFactoryClient.builder()
                        .baseUrl(baseUrl)
                        .apiKey(apiKey)
                        .userAgent("cat-factory-smoketest")
                        .build();
        CatFactoryClient readClient =
                CatFactoryClient.builder().baseUrl(baseUrl).apiKey(readKey).build();

        smoketest.run(client, readClient, baseUrl);

        Map<String, Object> report = new LinkedHashMap<>();
        report.put("sdk", "java");
        report.put("sdkVersion", Transport.SDK_VERSION);
        report.put("observations", smoketest.observations);
        report.put("failures", smoketest.failures);
        Files.writeString(
                out,
                new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT).writeValueAsString(report)
                        + "\n");

        if (!smoketest.failures.isEmpty()) {
            System.err.printf("java smoketest recorded %d failure(s):%n", smoketest.failures.size());
            smoketest.failures.forEach(failure -> System.err.println("  - " + failure));
            System.exit(1);
        }
        System.out.println("java smoketest completed");
    }

    private void run(CatFactoryClient client, CatFactoryClient readClient, String baseUrl) {
        step("services.list", () -> {
            var result = client.services().list();
            observations.put("serviceCount", result.services().size());
            serviceId = result.services().isEmpty() ? "" : result.services().get(0).serviceId();
            observations.put("firstServiceHasId", !serviceId.isEmpty());
        });

        step("pipelines.list", () -> {
            var result = client.pipelines().list();
            observations.put("pipelineCount", result.pipelines().size());
            long startable = result.pipelines().stream().filter(PublicPipeline::headlessStartable).count();
            observations.put("headlessStartableCount", (int) startable);
            // `public` is a keyword in Java and Kotlin, so the accessor is `isPublic()` while the
            // wire name stays `public`. Reading it here is what proves the escape did not change
            // what is on the wire — the other three SDKs read the same field under its own name.
            observations.put(
                    "publicPipelineCount",
                    (int) result.pipelines().stream().filter(PublicPipeline::isPublic).count());
            pipelineId =
                    result.pipelines().stream()
                            .filter(PublicPipeline::headlessStartable)
                            .map(PublicPipeline::pipelineId)
                            .findFirst()
                            .orElse("");
        });

        step("taskTypes.list", () -> {
            var result = client.taskTypes().list();
            observations.put("taskTypeCount", result.taskTypes().size());
            // The `bug` descriptors, which every deployment has: the count plus one field's
            // declared type, so four SDKs comparing reports catch one of them dropping the nested
            // option list or decoding an optional `type` differently.
            var bug =
                    result.taskTypes().stream()
                            .filter(t -> "bug".equals(t.taskType()))
                            .findFirst()
                            .orElse(null);
            var fields =
                    bug == null || bug.fields() == null ? List.<ListPublicTaskTypesResponseTaskTypeField>of() : bug.fields();
            var severity =
                    fields.stream().filter(f -> "severity".equals(f.key())).findFirst().orElse(null);
            observations.put("bugFieldCount", fields.size());
            observations.put(
                    "bugSeverityFieldType",
                    severity == null || severity.type() == null ? "" : severity.type().wireValue());
            observations.put(
                    "bugSeverityOptionCount",
                    severity == null || severity.options() == null ? 0 : severity.options().size());
        });

        step("tasks.create", () -> {
            PublicTask task =
                    client.tasks()
                            .create(
                                    serviceId,
                                    CreatePublicTask.builder()
                                            .title("SDK smoketest task")
                                            .description("Created by the cross-SDK smoketest.")
                                            .taskType("feature")
                                            .build());
            taskId = task.taskId();
            observations.put("createdStatus", String.valueOf(task.status().wireValue()));
            observations.put("createdTaskType", task.taskType());
            // A required-but-NULLABLE field: the server always sends it, and it is null here.
            // Recording it explicitly is what proves the four SDKs agree that "the server said
            // null" and "the server said nothing" are different facts.
            observations.put("createdRunIdIsNull", task.runId() == null);
            observations.put("createdPullRequestUrlIsNull", task.pullRequestUrl() == null);
        });

        step("tasks.update", () -> {
            PublicTask task =
                    client.tasks()
                            .update(taskId, UpdatePublicTask.builder().title("SDK smoketest task (edited)").build());
            observations.put("updatedTitle", task.title());
        });

        step("tasks.get", () -> {
            PublicTask task = client.tasks().get(taskId);
            observations.put("fetchedTitle", task.title());
            observations.put("fetchedStatus", task.status().wireValue());
        });

        step("tasks.listByService (one page)", () -> {
            var page =
                    client.tasks()
                            .listByService(serviceId, TasksListByServiceQuery.builder().limit(1).build());
            observations.put("pageSize", page.tasks().size());
            observations.put("pageHasCursor", page.nextCursor() != null);
        });

        step("tasks.listByServiceAll (auto-paging)", () -> {
            List<String> seen = new ArrayList<>();
            Iterator<PublicTask> tasks =
                    client.tasks()
                            .listByServiceAll(serviceId, TasksListByServiceQuery.builder().limit(1).build());
            while (tasks.hasNext()) {
                seen.add(tasks.next().taskId());
            }
            observations.put("pagedTaskCount", seen.size());
            observations.put("pagedContainsCreated", seen.contains(taskId));
            // A duplicate would mean the cursor was not advancing — the classic keyset paging bug,
            // and one a single-page test never sees.
            observations.put("pagedHasDuplicates", new HashSet<>(seen).size() != seen.size());
        });

        step("usage.get", () -> {
            PublicUsage usage = client.usage().get();
            observations.put("usageCurrency", usage.currency());
            observations.put("usageBudgetExceeded", usage.budget().exceeded());
            observations.put("usageRowsIsArray", usage.rows() != null);
        });

        step("notifications.list", () -> {
            var result = client.notifications().list();
            observations.put("notificationCount", result.notifications().size());
        });

        // The webhook round-trip is where the four clients are most exposed to a null decoding
        // differently: an unregistered endpoint is a `webhook: null` FIELD, and "the server said
        // null" must not arrive as an absence, an empty object, or a zero-valued struct in any
        // language.
        step("webhook.get / set / delete", () -> {
            PublicNotificationWebhook before = client.webhook().get();
            observations.put("webhookInitiallyNull", before.webhook() == null);
            NotificationWebhook saved = client.webhook().set(PutNotificationWebhook.builder()
                    .url("https://hooks.example.com/cat-factory-smoketest")
                    .secret("smoketest-signing-secret")
                    .runEvents(List.of(NotificationWebhookRunEvent.RUN_COMPLETED))
                    .build());
            observations.put("webhookSavedUrl", saved.url());
            // The secret is write-only: what comes back is the boolean, never the value.
            observations.put("webhookSavedHasSecret", saved.hasSecret());
            List<String> events = new ArrayList<>();
            for (NotificationWebhookRunEvent event : saved.runEvents()) {
                events.add(event.wireValue());
            }
            observations.put("webhookSavedRunEvents", String.join(",", events));
            // Omitting a field must send NO field, not an empty one: a `url: ""` here would blank
            // the endpoint on a call that only meant to add an alert subscription, and still
            // answer 200.
            NotificationWebhook edited = client.webhook().set(PutNotificationWebhook.builder()
                    .alertEvents(List.of(NotificationWebhookAlertEvent.PLATFORM_HEALTH_FIRING))
                    .build());
            observations.put("webhookUrlSurvivesOmittedUpdate", edited.url().equals(saved.url()));
            PublicNotificationWebhook read = client.webhook().get();
            observations.put(
                    "webhookReadMatchesSaved",
                    read.webhook() != null && read.webhook().url().equals(saved.url()));
            client.webhook().delete();
            observations.put("webhookNullAfterDelete", client.webhook().get().webhook() == null);
        });

        step("error: not found", () -> {
            try {
                client.tasks().get("blk_definitely_not_a_real_task");
                failures.add("error: not found — expected a 404, got a success");
            } catch (CatFactoryNotFoundException exc) {
                observations.put("notFoundIsTypedClass", true);
                observations.put("notFoundStatus", exc.status());
                observations.put("notFoundCode", exc.code());
                observations.put("notFoundHasRequestId", exc.requestId() != null);
            }
        });

        step("error: unauthorized", () -> {
            CatFactoryClient bogus =
                    CatFactoryClient.builder()
                            .baseUrl(baseUrl)
                            .apiKey("cf_live_pak_0000.deadbeef")
                            .build();
            try {
                bogus.services().list();
                failures.add("error: unauthorized — expected a 401, got a success");
            } catch (CatFactoryUnauthorizedException exc) {
                observations.put("unauthorizedIsTypedClass", true);
                observations.put("unauthorizedStatus", exc.status());
            }
        });

        step("error: insufficient scope", () -> {
            try {
                // A `read` key may list, but never create. The refusal carries a SURFACE-specific
                // code (`insufficient_scope`) rather than a status-class one, which is exactly the
                // case the SDKs deliberately do not narrow to an enum — so all four must surface
                // it verbatim.
                readClient
                        .tasks()
                        .create(serviceId, CreatePublicTask.builder().title("should be refused").build());
                failures.add("error: insufficient scope — expected a 403, got a success");
            } catch (CatFactoryForbiddenException exc) {
                observations.put("forbiddenIsTypedClass", true);
                observations.put("forbiddenStatus", exc.status());
                observations.put("forbiddenCode", exc.code());
            }
        });

        step("error: connection refused", () -> {
            // The one failure with no deployment on the other end of it, and the one whose MESSAGE
            // is the whole product: a caller with no checkout reads this line and nothing else. All
            // four clients must name the cause (nothing listening) rather than assert
            // unreachability, and must say what this client had seen from the origin, which
            // separates a restart from a bad address.
            // The key is a placeholder because nothing ever reads it: the request fails before a
            // connection exists to send it over, which is the whole point of the case.
            // The URL is RESERVED by the harness (a port bound and released), never named here: a
            // fetch-based runtime refuses the WHATWG bad-port list before opening a socket, so a
            // hardcoded low port asks the four clients different questions. See `reserveDeadUrl`.
            CatFactoryClient unreachable =
                    CatFactoryClient.builder()
                            .baseUrl(deadUrl)
                            .apiKey("cf_live_pak_0000.deadbeef")
                            .maxRetries(0)
                            .build();
            try {
                unreachable.services().list();
                failures.add("error: connection refused — expected a transport failure, got a success");
            } catch (CatFactoryConnectionException exc) {
                observations.put("connectionFailureIsTypedClass", true);
                String message = exc.getMessage() == null ? "" : exc.getMessage();
                observations.put("connectionFailureNamesTheCause", message.contains("nothing is listening"));
                observations.put("connectionFailureStatesHistory", message.contains("has not completed a call"));
            }
        });

        step("tasks.start", () -> {
            StartPublicTask.Builder body = StartPublicTask.builder();
            if (!pipelineId.isEmpty()) {
                body.pipelineId(pipelineId);
            }
            PublicTask task = client.tasks().start(taskId, body.build());
            observations.put("startedStatus", task.status().wireValue());
            observations.put("startedHasRunId", task.runId() != null);
        });

        step("tasks.stream (SSE)", () -> {
            List<String> events = new ArrayList<>();
            try (EventStream stream = client.tasks().stream(taskId)) {
                for (StreamEvent event : stream) {
                    events.add(event.event());
                    // The run's own terminal frames, plus the deployment's connection cap. Stopping
                    // at a fixed count as well keeps the smoketest bounded when a run parks on a
                    // human decision — which is a legitimate outcome, not a failure.
                    if (TERMINAL_SSE.contains(event.event()) || events.size() >= 3) {
                        break;
                    }
                }
            }
            observations.put("sseEventCount", events.size());
            observations.put("sseFirstEvent", events.isEmpty() ? null : events.get(0));
            observations.put("sseFramesAreKnown", KNOWN_SSE.containsAll(events));
        });

        step("tasks.getRun", () -> {
            PublicRun run = client.tasks().getRun(taskId);
            observations.put("runHasSteps", !run.steps().isEmpty());
            observations.put("runStatusIsKnown", KNOWN_RUN_STATUSES.contains(run.status().wireValue()));
        });

        step("tasks.stop", () -> {
            PublicTask task = client.tasks().stop(taskId);
            observations.put("stoppedStatus", task.status().wireValue());
        });

        step("tasks.delete", () -> {
            client.tasks().delete(taskId);
            try {
                client.tasks().get(taskId);
                failures.add("tasks.delete — the task was still readable after deletion");
                observations.put("deletedThenGone", false);
            } catch (CatFactoryNotFoundException exc) {
                observations.put("deletedThenGone", true);
            }
        });
    }

    /** Run one scenario step, recording a failure rather than aborting the rest of the run. */
    private void step(String name, Runnable body) {
        try {
            body.run();
        } catch (RuntimeException exc) {
            String detail =
                    exc instanceof CatFactoryApiException api
                            ? api.status() + " " + api.code() + ": " + api.apiMessage()
                            : String.valueOf(exc.getMessage());
            failures.add(name + ": " + detail);
        }
    }

    private static String requireEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isEmpty()) {
            System.err.println("smoketest: " + name + " is required");
            System.exit(2);
        }
        return value;
    }
}
