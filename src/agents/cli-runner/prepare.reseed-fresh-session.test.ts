// Extracted sibling of prepare.test.ts (kept separate to respect the per-file line cap).
// The authority-chain proof for the CLI history-reseed boundary, asserted at what actually
// becomes CLI input. The invariant these tests pin: a reseed prompt is emitted ONLY
// alongside a live cliHistoryWriter, so execute.ts's assertReadable always covers it.
// prepareCliHistoryBoundary returns a writer ONLY for the covered, account-owned path (an
// established same-account boundary or a proven-empty start that also establishes a writer);
// every other decline returns undefined, mapping to "auth-unknown" (no reseed) exactly as
// master refused. A fingerprint match alone never authorizes reseed; a writerless turn is
// never reseeded. These are the narrow guarantees the four prior review rounds kept losing.
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
 * reseed is present, else the prepended durable context on the plain prompt). */
function finalCliInput(context: Awaited<ReturnType<typeof prepareCliRunContext>>): string {
  return context.openClawHistoryPrompt ?? context.promptForHooks ?? context.params.prompt;
}

/** The invariant the narrow design enforces by construction: a reseed prompt is only ever
 * emitted when a live cliHistoryWriter accompanies it (so execute.ts installs assertReadable
 * over the later transcript read). No context can carry a reseed prompt with no writer. */
function assertReseedImpliesWriter(
  context: Awaited<ReturnType<typeof prepareCliRunContext>>,
): void {
  if (context.openClawHistoryPrompt !== undefined) {
    expect(context.cliHistoryWriter).toBeDefined();
  }
}

const STABLE_TOKEN = "stable-account";

describe("CLI history reseed boundary", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  const cleanups: Array<() => Promise<void> | void> = [];

  // Saves an auth-profile store so prepare resolves a stable credential, and returns a
  // prepare() closure bound to it. Does NOT pre-establish a history writer, so a first turn
  // under this account sees no prior boundary (the genuinely-fresh shape).
  function saveStableAccount(otherAccount = false) {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "history-test:account";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: { type: "token", provider: "test-cli", token: STABLE_TOKEN },
          "history-test:other": { type: "token", provider: "test-cli", token: "other-account" },
        },
      },
      agentDir,
    );
    const prepare = (overrides: Parameters<typeof fixture.prepare>[0] = {}) =>
      fixture.prepare({
        agentDir,
        authProfileId: otherAccount ? "history-test:other" : authProfileId,
        ...overrides,
      });
    return { agentDir, prepare };
  }

  // Establishes an owned CLI history writer under the stable credential, then returns a
  // prepare() closure for a later same-account turn plus the live writer, so a test can
  // advance the transcript THROUGH the writer (covered) or deliberately outside it
  // (uncovered). A later prepare then reseeds only when coverage is genuinely contiguous.
  async function establishOwnedAuth(otherAccount = false) {
    const { dir, sessionTarget } = fixture.session;
    const { agentDir, prepare: preparePartial } = saveStableAccount(otherAccount);
    const credential = { type: "token" as const, provider: "test-cli", token: STABLE_TOKEN };
    const runId = "fresh-reseed-fixture";
    await patchSessionEntryCore(sessionTarget, (entry) => ({ ...entry, activeWriterRunId: runId }));
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "fresh-reseed-fixture");
    cleanups.push(() => admission.close());
    const admittedRunContext = await admission.admit("embedded");
    const writer = await prepareCliHistoryBoundary(
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
      preparePartial({
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

  it("admits COVERED same-account history into the final CLI input with a live writer", async () => {
    const owned = await establishOwnedAuth();
    // Advance the transcript THROUGH the owned writer, so its coverage proof stays
    // contiguous. This is genuine same-account recovery: the writer re-establishes and the
    // prior content reaches what execute.ts sends as the CLI prompt — reseed WITH a writer.
    owned.appendCovered("prior covered ask");

    const context = await owned.prepare();

    expect(context.cliHistoryWriter).toBeDefined();
    expect(finalCliInput(context)).toContain("prior covered ask");
    expect(finalCliInput(context)).toContain("latest ask");
    assertReseedImpliesWriter(context);
  });

  it("reseeds a genuinely fresh session-less turn only while establishing a live writer", async () => {
    // A first turn under a stable credential with an empty transcript and no prior boundary:
    // the honest win. This is reseedable BECAUSE it establishes a writer (proven-empty start),
    // so execute.ts binds assertReadable over the read — never a writerless reseed.
    const { sessionTarget } = fixture.session;
    const { prepare } = saveStableAccount();
    await patchSessionEntryCore(sessionTarget, (entry) => ({
      ...entry,
      activeWriterRunId: "run-test",
    }));

    const context = await prepare();

    expect(context.cliHistoryWriter).toBeDefined();
    assertReseedImpliesWriter(context);
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
    assertReseedImpliesWriter(context);
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
    assertReseedImpliesWriter(context);
  });

  it("refuses reseed for a revoked/absent credential over uncovered content with no boundary", async () => {
    // No auth profile is saved and none is passed, so prepare resolves NO credential — the
    // revoked/absent-owner case. The session entry exists and matches (created by the
    // fixture) but carries no cliHistoryBoundary, and transcript content is present. Ownership
    // cannot be proven from an absent fingerprint, so a session-less turn over uncovered
    // content stays refused (master's behavior), not reseeded on `!cliSessionId` alone.
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: makeUserMessage("prior unowned ask", 1),
    });

    const context = await fixture.prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
    assertReseedImpliesWriter(context);
  });

  it("refuses a writerless session-less turn instead of reseeding (defect #4, and the regression)", async () => {
    // The behavior change from the over-broad version, and the regression proof. A stable
    // credential and an EMPTY transcript, but the boundary snapshot no longer matches the
    // session (pruned/reset or a projection race) — so no writer can be established. The
    // broad code classified this as a no-writer "fresh" start and reseeded, emitting an
    // openClawHistoryPrompt with NO cliHistoryWriter: a reseed that execute.ts's assertReadable
    // could not cover (a TOCTOU read past the empty-history decision). The narrow design
    // refuses every writerless turn, so the reseed prompt is absent. This assertion fails on
    // the un-narrowed code (prompt present, writer absent) and passes now.
    const { prepare } = saveStableAccount();
    const { sessionTarget } = fixture.session;
    replaceSessionEntrySync(sessionTarget, { sessionId: "mismatched-session", updatedAt: 0 });

    const context = await prepare();

    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
    // The core invariant, stated directly: no reseed prompt may exist without a live writer.
    assertReseedImpliesWriter(context);
  });

  it("proves the no-writer decline is what prepareCliHistoryBoundary itself returns", async () => {
    // The unit-level companion to the regression above: the boundary preparer returns no
    // writer for the mismatched-snapshot session-less turn, which prepare.ts maps to
    // "auth-unknown" (no reseed). This is the single fact that closes defect #4 by
    // construction — a writerless decline can never authorize a later transcript read.
    const { dir, sessionTarget } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const credential = { type: "token" as const, provider: "test-cli", token: STABLE_TOKEN };
    const runId = "snapshotless-empty";
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "snapshotless-empty");
    cleanups.push(() => admission.close());
    const admittedRunContext = await admission.admit("embedded");
    replaceSessionEntrySync(sessionTarget, { sessionId: "mismatched-session", updatedAt: 0 });

    const writer = await prepareCliHistoryBoundary(
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

    expect(writer).toBeUndefined();
  });
});
