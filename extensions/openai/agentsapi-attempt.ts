import { createHash } from "node:crypto";
import {
  agentHarnessAttemptTerminal,
  clearActiveEmbeddedRun,
  emitAgentEvent,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { calculateCost, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import { AgentsApiClient, type AgentsApiEvent } from "./agentsapi-client.js";

type SessionBinding = { sessionId: string; authFingerprint: string };

/** Session IDs survive Gateway restarts in the existing plugin SQLite store. */
export function agentsApiBindingStore(runtime: PluginRuntime) {
  return runtime.state.openSyncKeyedStore<SessionBinding>({
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
  });
}

export async function runAgentsApiAttempt(
  params: AgentHarnessAttemptParamsV2,
  runtime: PluginRuntime,
  assertHarnessCurrent: () => void,
): Promise<AgentHarnessAttemptResult> {
  const assertCurrent = () => {
    assertHarnessCurrent();
    params.hostCapabilities.assertActive();
  };
  assertCurrent();
  const sessionTarget = params.sessionTarget;
  if (!sessionTarget) { throw new Error("Agents API requires a host-prepared session target"); }
  if (!params.resolvedApiKey) {
    throw new Error("Agents API MVP requires an OpenAI API key");
  }
  if (params.images?.length || params.sandbox) {
    throw new Error(
      "Agents API MVP supports text and its hosted VM only; images and Gateway sandbox placement are unsupported",
    );
  }
  if (params.contextEngine && params.contextEngine.info.id !== "legacy") {
    throw new Error("Agents API MVP currently supports only the default legacy context engine");
  }
  const controller = new AbortController();
  const client = new AgentsApiClient(params.resolvedApiKey, assertCurrent);
  // Cancellation retires already admitted remote work even after host authority closes.
  const cleanupClient = new AgentsApiClient(params.resolvedApiKey, assertHarnessCurrent);
  const store = agentsApiBindingStore(runtime);
  const fingerprint = createHash("sha256").update(params.resolvedApiKey).digest("hex");
  let binding = store.lookup(params.sessionId);
  if (binding && binding.authFingerprint !== fingerprint) {
    throw new Error("Agents API credential changed; reset the OpenClaw session before continuing");
  }
  let remoteSessionId = binding?.sessionId;
  let submitted = false;
  let stopped = false;
  let interrupted = false;
  let timedOut = false;
  let cancellation: Promise<void> | undefined;
  let submission: Promise<void> = Promise.resolve();
  const submit = (text: string) => {
    assertCurrent();
    if (!remoteSessionId || stopped) {
      throw new Error("Agents API turn is stopped");
    }
    const sessionId = remoteSessionId;
    submission = submission.then(() =>
      client.message(sessionId, text, AbortSignal.timeout(60_000)),
    );
    void submission.catch(() => {});
    return submission;
  };
  let terminal: ReturnType<typeof agentHarnessAttemptTerminal.normalize> = { kind: "ok" };
  let rootTurn: AgentsApiEvent["turn"];
  const texts = new Map<string, string>();
  let usage: AssistantMessage["usage"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const stop = (requested = true) => {
    if (stopped) {
      return;
    }
    stopped = true;
    interrupted = requested;
    if (requested) { params.onAttemptAbort?.(); }
    controller.abort(new Error("Agents API turn interrupted"));
    if (remoteSessionId && submitted) {
      const sessionId = remoteSessionId;
      const admittedSubmission = submission;
      cancellation = (async () => {
        // Do not abort an admitted POST: cancel only after its response settles.
        // An uncertain submission remains a failure even if cancellation succeeds.
        let submissionError: unknown;
        try {
          await admittedSubmission;
        } catch (error) {
          submissionError = error;
        }
        await cleanupClient.cancel(sessionId, AbortSignal.timeout(30_000));
        if (submissionError) {
          throw submissionError;
        }
      })();
      // The settlement barrier below observes errors; attach immediately to prevent unhandled rejection.
      void cancellation.catch(() => {});
    }
  };
  const handle = {
    kind: "embedded" as const,
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    supportsTranscriptCommitWait: true,
    runId: params.runId,
    startedAtMs: Date.now(),
    queueMessage: async (
      text: string,
      options?: Parameters<Parameters<typeof setActiveEmbeddedRun>[1]["queueMessage"]>[1],
    ) => {
      assertCurrent();
      if (stopped || !remoteSessionId || !submitted) {
        throw new Error("Agents API turn is not ready for steering");
      }
      if (options?.images?.length) {
        throw new Error("Agents API MVP accepts text steering only");
      }
      await options?.userTurnTranscriptRecorder?.persistApproved();
      assertCurrent();
      await submit(text);
      options?.userTurnTranscriptRecorder?.markSentToProvider?.();
    },
    isStreaming: () => submitted && !stopped,
    isStopped: () => stopped,
    isAborted: () => stopped,
    isCompacting: () => false,
    abort: () => stop(),
    cancel: () => stop(),
  };
  const onAbort = () => stop();
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    params.onAttemptTimeout?.(new Error("Agents API attempt timed out"));
    stop();
  }, params.timeoutMs);
  params.replyOperation?.attachBackend(handle);
  setActiveEmbeddedRun(
    params.sessionId,
    handle,
    params.sessionKey,
    params.sessionFile,
    params.agentId,
  );
  let lastAssistant: AssistantMessage | undefined;
  try {
    if (params.abortSignal?.aborted) {
      stop();
    }
    controller.signal.throwIfAborted();
    if (!remoteSessionId) {
      remoteSessionId = await client.create(
        controller.signal,
        [
          "You are the OpenClaw assistant. Use your hosted Linux workspace for commands and files.",
          "This MVP has no apps, connectors, OpenClaw tools, file transfers, or image generation. Do not claim access to them.",
          params.extraSystemPrompt,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      assertCurrent();
      binding = { sessionId: remoteSessionId, authFingerprint: fingerprint };
      store.register(params.sessionId, binding);
    }
    const events = await client.subscribe(remoteSessionId, controller.signal);
    try {
      await params.userTurnTranscriptRecorder?.persistApproved();
      assertCurrent();
      // Mark before sending: an uncertain POST may already have started remote work.
      submitted = true;
      await submit(params.prompt);
      params.userTurnTranscriptRecorder?.markSentToProvider?.();
      emitAgentEvent({ runId: params.runId, stream: "lifecycle", data: { phase: "start" } });
      for await (const event of events) {
        assertCurrent();
        if (event.type === "error") {
          throw new Error(event.error?.message ?? "Agents API stream error");
        }
        if (
          [
            "agent.session.failed",
            "agent.session.environment.failed",
            "agent.session.requires_action",
          ].includes(event.type)
        ) {
          throw new Error(`Agents API MVP cannot continue: ${event.type}`);
        }
        if (
          event.type === "agent.session.turn.output_text.delta" ||
          event.type === "agent.session.turn.output_text.done"
        ) {
          const key = `${event.item_id}:${event.content_index ?? 0}`;
          texts.set(
            key,
            event.type.endsWith(".done")
              ? (event.text ?? "")
              : (texts.get(key) ?? "") + (event.delta ?? ""),
          );
          emitAgentEvent({
            runId: params.runId,
            stream: "assistant",
            data: { text: [...texts.values()].join("\n"), delta: event.delta ?? "" },
          });
          await params.onPartialReply?.({ text: [...texts.values()].join("\n") });
        }
        if (
          event.type.startsWith("agent.session.turn.") &&
          event.turn?.subagent_id === null &&
          [
            "agent.session.turn.completed",
            "agent.session.turn.failed",
            "agent.session.turn.cancelled",
          ].includes(event.type)
        ) {
          rootTurn = event.turn;
          if (event.type.endsWith(".failed")) {
            throw new Error(event.turn.error?.message ?? "Agents API turn failed");
          }
          if (event.type.endsWith(".cancelled")) {
            terminal = { kind: "aborted", source: "runtime" };
          }
          break;
        }
      }
    } finally {
      await events.return(undefined);
    }
    if (!rootTurn) {
      throw new Error(
        "Agents API stream closed before the root turn settled; reset or inspect the session before retrying",
      );
    }
    if (terminal.kind === "ok") {
      const items = await client.items(remoteSessionId, rootTurn.id, controller.signal);
      assertCurrent();
      const completedMessages = items.filter(
        (item) =>
          item.type === "message" && item.role === "assistant" && item.status === "completed",
      );
      const finalItems = completedMessages.filter((item) => item.phase === "final_answer");
      const visibleItems = finalItems.length
        ? finalItems
        : completedMessages.filter((item) => item.phase !== "commentary");
      const text = visibleItems
        .map(
          (item) =>
            item.content
              ?.filter((part) => part.type === "output_text")
              .map((part) => part.text ?? "")
              .join("") ?? "",
        )
        .join("\n");
      const nativeUsage = rootTurn.usage;
      if (nativeUsage) {
        usage = {
          ...usage,
          input: nativeUsage.input_tokens - (nativeUsage.input_tokens_details?.cached_tokens ?? 0),
          output: nativeUsage.output_tokens,
          cacheRead: nativeUsage.input_tokens_details?.cached_tokens ?? 0,
          totalTokens: nativeUsage.input_tokens + nativeUsage.output_tokens,
        };
        params.hostCapabilities.reportOutputTokens?.(usage.output);
        calculateCost(params.model, usage);
      }
      if (text) {
        const assistant: AssistantMessage & { idempotencyKey: string } = {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-6-astra",
          usage,
          stopReason: "stop",
          timestamp: Date.now(),
          idempotencyKey: `agentsapi:${remoteSessionId}:${rootTurn.id}`,
        };
        const append = await appendSessionTranscriptMessageByIdentityStrict({
          ...sessionTarget,
          config: params.config,
          message: assistant,
          prepareMessageAfterIdempotencyCheck: (message) => {
            assertCurrent();
            return message;
          },
        });
        assertCurrent();
        if (append.kind !== "result") {
          throw new Error("Agents API assistant transcript append was refused");
        }
        lastAssistant = append.result.message;
      }
    }
  } catch (error) {
    if (!stopped && submitted && !rootTurn) {
      stop(false);
    }
    terminal = timedOut
      ? { kind: "timeout", phase: "prompt", source: "runtime", aborted: true }
      : params.abortSignal?.aborted
        ? { kind: "aborted", source: "external" }
        : interrupted
          ? { kind: "aborted", source: "runtime" }
          : { kind: "failed", source: "prompt", error };
  } finally {
    clearTimeout(timer);
    params.abortSignal?.removeEventListener("abort", onAbort);
    try {
      await cancellation;
    } catch (error) {
      terminal = { kind: "failed", source: "prompt", error };
    }
    stopped = true;
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
  }
  const assistantTexts =
    lastAssistant?.content.filter((part) => part.type === "text").map((part) => part.text) ?? [];
  return {
    terminal,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    agentHarnessId: "agentsapi",
    messagesSnapshot: SessionManager.open(
      sessionTarget,
      params.workspaceDir,
    ).buildSessionContext().messages,
    assistantTexts,
    lastAssistant,
    currentAttemptAssistant: lastAssistant,
    currentAttemptCompletedAssistant: lastAssistant,
    assistantTranscriptOwned: Boolean(lastAssistant),
    assistantTranscriptIdempotencyKey:
      lastAssistant && rootTurn ? `agentsapi:${remoteSessionId}:${rootTurn.id}` : undefined,
    toolMetas: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    attemptUsage: usage,
    // Hosted commands are opaque to the Gateway; an admitted turn is never automatically replayed.
    replayMetadata: { hadPotentialSideEffects: submitted, replaySafe: !submitted },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}
