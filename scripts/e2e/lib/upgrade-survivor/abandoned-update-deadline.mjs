import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [command, first, second] = process.argv.slice(2);
const budgetMs = 15_000;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

if (command === "hook") {
  const dist = path.join(first, "dist");
  const modules = fs
    .readdirSync(dist)
    .filter((file) => /\.[cm]?js$/u.test(file))
    .map((file) => ({
      url: pathToFileURL(path.join(dist, file)).href,
      source: fs.readFileSync(path.join(dist, file), "utf8"),
    }));
  const marker = "async function updatePluginsAfterCoreUpdate(params) {";
  const plugins = modules.filter((module) => module.source.includes(marker));
  const mutations = modules.filter((module) =>
    /mutateConfigFileWithRetry as \w+/u.test(module.source),
  );
  assert.equal(plugins.length, 1, "one built plugin-convergence owner must be injectable");
  assert.equal(mutations.length, 1, "one built config mutation owner must be exported");
  const mutationExport = /mutateConfigFileWithRetry as (\w+)/u.exec(mutations[0].source)[1];
  const output = path.join(second, "repair-deadline-hook.mjs");
  fs.writeFileSync(
    output,
    `
import { registerHooks } from 'node:module';
import fs from 'node:fs';
const update = process.argv.indexOf('update');
if (update >= 2 && process.argv[update + 1] === 'repair') {
  const key = Symbol.for('openclaw.e2e.repair-deadline');
  globalThis[key] = async params => {
    console.error('[fixture] Plugin convergence entered; waiting past its ${budgetMs}ms deadline.');
    await new Promise(resolve => setTimeout(resolve, ${budgetMs + 1_000}));
    const writer = await import(${JSON.stringify(mutations[0].url)});
    try {
      await writer[${JSON.stringify(mutationExport)}]({
        writeOptions: params.configWriteOptions,
        mutate: draft => { draft.update = { ...draft.update, channel: 'beta' }; },
      });
      throw new Error('The late config write was applied');
    } catch (error) {
      if (!error.message.includes('Update finalization timed out in plugins after ${budgetMs}ms')) throw error;
      fs.writeFileSync(${JSON.stringify(path.join(second, "deadline-write-refused.json"))}, JSON.stringify({ phase: 'plugins', deadlineMs: ${budgetMs}, refused: true }));
      console.error('[fixture] Late config write refused by the expired phase authority.');
      throw error;
    }
  };
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== ${JSON.stringify(plugins[0].url)}) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    if (!source.includes(${JSON.stringify(marker)})) throw new Error('Plugin deadline injection target changed');
    return { ...loaded, source: source.replace(${JSON.stringify(marker)}, ${JSON.stringify(`${marker}\n  await globalThis[Symbol.for('openclaw.e2e.repair-deadline')](params);`)}) };
  }});
}
`,
  );
  console.log(output);
} else if (command === "verify") {
  const stateDir = first;
  const artifacts = second;
  assert.equal(Number(fs.readFileSync(path.join(artifacts, "deadline-repair.exit"), "utf8")), 1);
  const result = readJson(path.join(artifacts, "deadline-repair.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.stuckPhase, "plugins");
  assert.deepEqual(readJson(path.join(artifacts, "deadline-write-refused.json")), {
    phase: "plugins",
    deadlineMs: budgetMs,
    refused: true,
  });
  assert.equal(readJson(process.env.OPENCLAW_CONFIG_PATH).update.channel, "stable");
  const before = readJson(path.join(artifacts, "deadline-service-before.json"));
  const after = readJson(path.join(artifacts, "deadline-service-after.json"));
  assert.notDeepEqual(after.gateway, before.gateway, "the stopped Gateway must be restored");
  assert.equal(after.unitSha256, before.unitSha256);
  const callers = after.callers.slice(before.callers.length);
  assert.equal(callers.length, 2);
  assert.equal(callers[0].action, "stop");
  assert(["start", "restart"].includes(callers[1].action));
  for (const { roles } of callers) {
    assert(roles.includes("update"));
    assert(!roles.includes("doctor"));
  }
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  let warning;
  try {
    const run = db
      .prepare(
        "SELECT status, reason, steps_json FROM update_runs ORDER BY created_at_ms DESC LIMIT 1",
      )
      .get();
    assert.equal(run.status, "failed");
    assert.equal(run.reason, "finalization-timeout");
    warning = JSON.parse(run.steps_json).find(
      (step) => step.step === "warning:finalize:plugins:deadline",
    );
    assert.equal(warning?.status, "completed");
    assert(warning.detail.includes(`timed out in plugins after ${budgetMs}ms`));
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM update_runs WHERE status = 'running'").get().n,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM state_leases WHERE scope = 'core:plugin-lifecycle'")
        .get().n,
      0,
    );
  } finally {
    db.close();
  }
  const stderr = fs.readFileSync(path.join(artifacts, "deadline-repair.err"), "utf8");
  assert(stderr.includes("Gateway restarted and verified after Doctor repair."));
  for (const line of stderr.split("\n")) {
    if (
      line.startsWith("[fixture]") ||
      line.includes("Gateway restarted and verified") ||
      line.includes("warning:finalize:plugins:deadline")
    ) {
      console.log(line);
    }
  }
  console.log(
    JSON.stringify({
      phase: "plugins",
      deadlineMs: budgetMs,
      exitCode: 1,
      gatewayRestored: true,
      gatewayPid: after.gateway.pid,
      lateWriteRefused: true,
      custodyReleased: true,
      warning: warning.detail,
    }),
  );
} else {
  throw new Error(`Unknown deadline fixture command: ${command}`);
}
