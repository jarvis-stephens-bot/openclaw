import { createHash } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  isKnownCliHistoryBoundary,
  runWithCliHistoryWriter,
  type CliHistoryBoundary,
  type CliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  readSessionTranscriptWatermark,
  resolveSessionTranscriptDatabasePath,
  validateSessionTranscriptContextAdmission,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { assertOwnedTranscriptWriteCommit } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { bindAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { buildSessionContext, SessionManager } from "../sessions/session-manager.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

/**
 * Why history preparation declined to hand back a writer. `"fresh"` means a genuinely
 * session-less start with no borrowed native handle and no prior transcript owned by a
 * different credential — safe to reseed like a missing transcript. `"refused"` covers
 * every non-fresh decline (a reused/forced native session, an account transition, or an
 * untrusted boundary); reseeding then would leak borrowed history, so it stays refused.
 */
type CliHistoryBoundaryDecline = "fresh" | "refused";

/**
 * Discriminated result: `writer` present on success, otherwise `declined` says why so
 * the caller can reseed a fresh start while still refusing an account boundary. The two
 * were previously collapsed into one `undefined`, which reseeded borrowed history.
 */
export type CliHistoryBoundaryResult = {
  writer?: CliHistoryWriter;
  declined?: CliHistoryBoundaryDecline;
};

/**
 * History belongs to the local transcript, not the latest native handle. Cover only
 * a proven-empty start or the contiguous events of the previously admitted CLI run.
 * An account transition, old-runtime write, import or unknown legacy prefix stays
 * unknown until an explicitly empty context starts a new history boundary.
 */
export async function prepareCliHistoryBoundary(
  params: PreparedCliRunContext["params"],
  identity: { credential?: AuthProfileCredential },
): Promise<CliHistoryBoundaryResult> {
  const source = params.sessionTarget;
  // A source under a *different* session identity, or a borrowed/forced native handle, is
  // not this run's own history: it must never reseed. Explicit caller memory (sessionManager)
  // and a genuinely session-less turn (no transcript to leak) may reseed like a missing
  // transcript. This decides every early "cannot establish a writer" exit below.
  const borrowed =
    (source !== undefined &&
      (source.sessionId !== params.sessionId ||
        (params.sessionKey !== undefined && params.sessionKey !== source.sessionKey))) ||
    Boolean(params.cliSessionId) ||
    params.cliSessionBinding?.forceReuse === true;
  const declinedEarly: CliHistoryBoundaryDecline =
    params.sessionManager || !borrowed ? "fresh" : "refused";
  if (
    params.sessionManager ||
    !source ||
    source.sessionId !== params.sessionId ||
    (params.sessionKey !== undefined && params.sessionKey !== source.sessionKey) ||
    !resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
  ) {
    return { declined: declinedEarly };
  }
  const target = { ...source, storePath: resolveSessionTranscriptDatabasePath(source) };
  const assertCurrent = createCliRunCurrentAssertion(params);
  await waitForSessionTranscriptProjection(target);
  assertCurrent();
  const snapshot: InternalSessionEntry | undefined = loadSessionEntryReadOnly(target);
  if (!snapshot || snapshot.sessionId !== target.sessionId) {
    return { declined: declinedEarly };
  }
  const watermark = readSessionTranscriptWatermark(target);
  const admission = resolveSessionTranscriptReadFence(target);
  validateSessionTranscriptContextAdmission(target, admission);
  const priorMaxSeq = admission ? admission.rawSeq - 1 : watermark.maxSeq;
  const currentUserIsLast = !admission || watermark.maxSeq === admission.rawSeq;
  const stored = snapshot.cliHistoryBoundary;
  const credential = identity.credential;
  // Native reuse epochs intentionally tolerate identity-less OAuth and stable
  // SecretRefs. History cannot: use the resolved static credential or a named
  // OAuth account, never a profile name, reference, or opaque CLI login alone.
  const owner =
    credential?.type === "oauth"
      ? credential.accountId?.trim() || credential.email?.trim()
        ? [
            "oauth",
            credential.provider,
            credential.accountId,
            credential.email,
            credential.clientId,
            credential.enterpriseUrl,
            credential.projectId,
          ]
        : undefined
      : credential?.type === "api_key" && credential.key?.trim()
        ? ["api_key", credential.provider, credential.key]
        : credential?.type === "token" && credential.token?.trim()
          ? ["token", credential.provider, credential.token]
          : undefined;
  const fingerprint = owner
    ? createHash("sha256")
        .update(JSON.stringify(["cli-history-v1", normalizeProviderId(params.provider), owner]))
        .digest("hex")
    : undefined;
  const writerRunId = params.expectedWriterRunId ?? params.runId;
  let allowed = Boolean(
    fingerprint &&
    currentUserIsLast &&
    params.cliSessionBinding?.forceReuse !== true &&
    isKnownCliHistoryBoundary(stored) &&
    stored.sessionId === target.sessionId &&
    stored.authFingerprint === fingerprint &&
    stored.generation === watermark.generation &&
    (stored.maxSeq === priorMaxSeq ||
      (admission && stored.writerRunId === writerRunId && stored.maxSeq === watermark.maxSeq)),
  );
  if (
    !allowed &&
    fingerprint &&
    currentUserIsLast &&
    !params.cliSessionId &&
    !params.cliSessionBinding
  ) {
    let truncated = false;
    const branch = SessionManager.openBounded(target, {
      maxBytes: 1024 * 1024,
      maxEvents: 100,
      onTruncated: () => {
        truncated = true;
      },
    }).getBranch();
    // Bookkeeping is not a conversation. Retained reset rows, summaries, custom
    // context, missing anchors and bounded cuts must never look like a fresh start.
    allowed = !truncated && buildSessionContext(branch).messages.length === 0;
  }
  allowed &&= watermark.maxSeq === null || typeof watermark.generation === "string";
  // Classify why a writer could not be established, so the caller reseeds a genuinely
  // fresh start but refuses borrowed history. A prior boundary owned by the current
  // fingerprint is the current account's own history (safe to reseed like a missing
  // transcript); a boundary owned by a different fingerprint, or an untrusted
  // "unknown"-state boundary, is an account transition that must stay refused. With no
  // prior boundary at all, only a session-less turn (no reused/forced native handle) is
  // fresh — a borrowed native handle cannot authorize unverified durable history.
  const ownedByCurrent =
    isKnownCliHistoryBoundary(stored) && stored.authFingerprint === fingerprint;
  const isFreshStart = stored ? ownedByCurrent : !params.cliSessionId && !params.cliSessionBinding;
  const declined: CliHistoryBoundaryDecline = isFreshStart ? "fresh" : "refused";
  if (!allowed && !stored) {
    return { declined };
  }
  const boundary: CliHistoryBoundary =
    allowed && fingerprint
      ? {
          version: 1,
          sessionId: target.sessionId,
          state: "known",
          authFingerprint: fingerprint,
          generation: watermark.generation,
          maxSeq: watermark.maxSeq,
          writerRunId,
        }
      : { version: 1, sessionId: target.sessionId, state: "unknown" };
  const committed = await patchSessionEntryCore(
    target,
    (current: InternalSessionEntry) => {
      if (
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== snapshot.lifecycleRevision ||
        current.activeWriterRunId !== snapshot.activeWriterRunId ||
        (current.activeWriterRunId !== undefined && current.activeWriterRunId !== writerRunId) ||
        (params.expectedLifecycleRevision !== undefined &&
          current.lifecycleRevision !== params.expectedLifecycleRevision)
      ) {
        throw new Error("CLI history owner changed before preparation");
      }
      const patch: Partial<InternalSessionEntry> = { cliHistoryBoundary: boundary };
      return patch;
    },
    {
      preserveActivity: true,
      skipMaintenance: true,
      assertCommitAllowed: () => {
        assertCurrent();
        assertOwnedTranscriptWriteCommit(target);
        validateSessionTranscriptContextAdmission(target, admission);
        const fresh = readSessionTranscriptWatermark(target);
        if (fresh.generation !== watermark.generation || fresh.maxSeq !== watermark.maxSeq) {
          throw new Error("CLI history changed before preparation");
        }
      },
    },
  );
  if (!committed || !allowed || boundary.state !== "known") {
    return { declined };
  }
  const assertActive = resolveAdmittedRunActiveAssertion(params.admittedRunContext);
  const assertWriterCurrent = () => {
    params.assertCurrent?.();
    if (!assertActive) {
      throw new Error("CLI history writer is no longer active");
    }
    assertActive();
  };
  const writer: CliHistoryWriter = {
    target: { ...target },
    runId: writerRunId,
    authFingerprint: boundary.authFingerprint,
    lifecycleRevision: snapshot.lifecycleRevision,
    expectedWriterRunId: snapshot.activeWriterRunId,
    assertCurrent: assertWriterCurrent,
    assertReadable: () => {
      assertWriterCurrent();
      const current: InternalSessionEntry | undefined = loadSessionEntryReadOnly(target);
      const proof = current?.cliHistoryBoundary;
      const tip = readSessionTranscriptWatermark(target);
      if (
        !current ||
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== snapshot.lifecycleRevision ||
        current.activeWriterRunId !== snapshot.activeWriterRunId ||
        !isKnownCliHistoryBoundary(proof) ||
        proof.sessionId !== target.sessionId ||
        proof.writerRunId !== writerRunId ||
        proof.authFingerprint !== boundary.authFingerprint ||
        proof.generation !== tip.generation ||
        proof.maxSeq !== tip.maxSeq
      ) {
        throw new Error("CLI history authority changed before execution");
      }
    },
  };
  const authority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  if (!authority) {
    throw new Error("CLI history writer is no longer active");
  }
  bindAgentRunTerminalWriteContext(authority, {
    run: (write) => runWithCliHistoryWriter(writer, write),
  });
  return { writer };
}
