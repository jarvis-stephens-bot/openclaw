// Extracted sibling of prepare.test.ts (kept separate to respect the per-file line
// cap). The authority-chain proof for the fresh-session reseed boundary, asserted at what
// actually becomes CLI input: the revised owner admits genuinely COVERED same-account
// context (appended through the owned writer) and rejects foreign, uncovered (appended
// outside the writer), snapshotless, and revoked history — and its live coverage guard
// still holds through dispatch, rejecting coverage invalidated between preparation and the
// final CLI read. A fingerprint match alone never authorizes reseed; only proven coverage
// (or a proven-empty session-less start) does.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
} from "../cli-runner.test-helpers.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

/** The prompt that execute.ts assembles as final CLI input (openClawHistoryPrompt when a
 * fresh reseed is present, else the prepended durable context on the plain prompt). */
function finalCliInput(context: Awaited<ReturnType<typeof prepareCliRunContext>>): string {
  return context.openClawHistoryPrompt ?? context.promptForHooks ?? context.params.prompt;
}

describe("CLI fresh session-less reseed boundary", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  // Establishes an owned CLI history writer under a stable credential. Returns a prepare()
  // closure for a later same-account turn, plus the live writer so a test can advance the
  // transcript through it (COVERED coverage) or deliberately outside it (UNCOVERED). A
  // later prepare then reseeds only when coverage is genuinely contiguous.
  async function establishOwnedAuth(otherAccount = false) {
    const { dir, sessionTarget } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "history-test:account";
    const credential = { type: "token" as const, provider: "test-cli", token: "stable-account" };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: credential,
          "history-test:other": { type: "token", provider: "test-cli", token: "other-account" },
        },
      },
      agentDir,
    );
    const runId = "fresh-reseed-fixture";
    await patchSessionEntryCore(sessionTarget, (entry) => ({ ...entry, activeWriterRunId: runId }));
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "fresh-reseed-fixture");
    cleanups.push(() => admission.close());
    const admittedRunContext = await admission.admit("embedded");
    const { writer } = await prepareCliHistoryBoundary(
      {
        admittedRunContext,
        runId,
        agentDir,
        provider: "test-cli",
        model: "test-model",
        prompt: "seed",
        workspaceDir: dir,
        timeoutMs: 1000,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        sessionFile: sessionTarget.sessionKey,
        sessionTarget,
      },
      { credential },
    );
    expect(writer).toBeDefined();
    const prepare = (overrides: Parameters<typeof fixture.prepare>[0] = {}) =>
      fixture.prepare({
        agentDir,
        authProfileId: otherAccount ? "history-test:other" : authProfileId,
        runId,
        admittedRunContext,
        sessionKey: sessionTarget.sessionKey,
        ...overrides,
      });
    // Records the append under the owned writer so its coverage proof advances — the
    // contiguous, genuinely-covered shape (as opposed to fixture.appendTranscript, which
    // writes outside the writer and leaves coverage stale/uncovered).
    const appendCovered = (content: string) =>
      runWithCliHistoryWriter(writer, () =>
        fixture.appendTranscript({
          id: "covered-1",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: makeUserMessage(content, 1),
        }),
      );
    return { prepare, appendCovered, writer };
  }

  beforeEach(() => {
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        buildDefaultTestCliBackend({ reseedFromRawTranscriptWhenUncompacted: true }),
      ],
    });
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      vi.restoreAllMocks();
      resetCliRunnerPrepareTestDeps();
      cliBackendsTesting.resetDepsForTest();
      fixture.cleanup();
    }
  });

  it("admits COVERED same-account history into the final CLI input", async () => {
    const owned = await establishOwnedAuth();
    // Advance the transcript THROUGH the owned writer, so its coverage proof stays
    // contiguous. This is genuine same-account recovery — the writer re-establishes and the
    // prior content reaches what execute.ts sends as the CLI prompt.
    owned.appendCovered("prior covered ask");

    const context = await owned.prepare();

    expect(context.cliHistoryWriter).toBeDefined();
    expect(finalCliInput(context)).toContain("prior covered ask");
    expect(finalCliInput(context)).toContain("latest ask");
  });

  it("refuses reseed for a fingerprint-matching boundary whose coverage went stale", async () => {
    const owned = await establishOwnedAuth();
    // Advance the transcript OUTSIDE the owned writer: the credential (fingerprint) still
    // matches the stored boundary, but coverage is now stale (an unrecorded append). A
    // fingerprint match alone must NOT reseed — `allowed` is false, so this is refused and
    // the uncovered rows never reach the CLI input. This is the exact leak clawsweeper found.
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("uncovered same-account ask", 1),
    });

    const context = await owned.prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
    expect(finalCliInput(context)).not.toContain("uncovered same-account ask");
  });

  it("rejects a coverage invalidation between preparation and the dispatch read guard", async () => {
    const owned = await establishOwnedAuth();
    owned.appendCovered("prior covered ask");
    const context = await owned.prepare();
    // Covered recovery hands back a live writer; execute.ts binds its assertReadable as the
    // per-turn assertCurrent, so the coverage proof is re-verified at the final CLI read.
    expect(context.cliHistoryWriter).toBeDefined();
    expect(() => context.cliHistoryWriter?.assertReadable()).not.toThrow();
    // Invalidate coverage AFTER preparation, before dispatch — an unrecorded append advances
    // the transcript past the proof. The live guard must reject it, so the stale reseed can
    // never reach actual CLI input even though preparation already approved it.
    fixture.appendTranscript({
      id: "msg-after-prepare",
      parentId: null,
      timestamp: new Date(2).toISOString(),
      message: makeUserMessage("post-prepare drift", 2),
    });

    expect(() => context.cliHistoryWriter?.assertReadable()).toThrow();
  });

  it("refuses reseed across an account boundary even when a transcript exists", async () => {
    const owned = await establishOwnedAuth(true);
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior account-owned ask", 1),
    });

    const context = await owned.prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
    expect(finalCliInput(context)).not.toContain("prior account-owned ask");
  });

  it("refuses reseed when the boundary snapshot is missing but uncovered content remains", async () => {
    const owned = await establishOwnedAuth();
    const { sessionTarget } = fixture.session;
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior uncovered ask", 1),
    });
    // Drop the boundary entry to a mismatched session id while the transcript content
    // survives — an entry pruned/reset or a projection race. This is exactly the early
    // return where `loadSessionEntryReadOnly` yields no matching snapshot AFTER the
    // same-session checks passed. Ownership was never verified, so the content must NOT
    // be replayed; master refused it, and reseeding it would leak uncovered history.
    replaceSessionEntrySync(sessionTarget, { sessionId: "mismatched-session", updatedAt: 0 });

    const context = await owned.prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
  });

  it("classifies a snapshotless but proven-empty transcript as a fresh start", async () => {
    const { dir, sessionTarget } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const credential = { type: "token" as const, provider: "test-cli", token: "stable-account" };
    const runId = "snapshotless-empty";
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "snapshotless-empty");
    cleanups.push(() => admission.close());
    const admittedRunContext = await admission.admit("embedded");
    // Mismatched boundary snapshot, but no transcript content beyond the session header:
    // there is nothing to leak, so the missing-snapshot early return must still classify
    // this genuinely session-less turn as "fresh" (reseedable) rather than over-refusing.
    replaceSessionEntrySync(sessionTarget, { sessionId: "mismatched-session", updatedAt: 0 });

    const result = await prepareCliHistoryBoundary(
      {
        admittedRunContext,
        runId,
        agentDir,
        provider: "test-cli",
        model: "test-model",
        prompt: "hi",
        workspaceDir: dir,
        timeoutMs: 1000,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        sessionFile: sessionTarget.sessionKey,
        sessionTarget,
      },
      { credential },
    );

    expect(result.writer).toBeUndefined();
    expect(result.declined).toBe("fresh");
  });

  it("refuses reseed for a revoked/absent credential over uncovered content with no boundary", async () => {
    // No auth profile is saved and none is passed, so prepare resolves NO credential — the
    // revoked/absent-owner case. The session entry exists and matches (created by the
    // fixture) but carries no cliHistoryBoundary, and transcript content is present. This is
    // the later `!stored` exit: ownership cannot be proven from an absent fingerprint and
    // there is no boundary to match against, so a session-less turn over uncovered content
    // must stay refused — master's behavior — not reseed on `!cliSessionId` alone.
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior unowned ask", 1),
    });

    const context = await fixture.prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
  });
});
