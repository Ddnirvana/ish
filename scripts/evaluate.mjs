#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { IntentClient } from "../dist/src/client.js";
import { IntentDaemon } from "../dist/src/daemon.js";
import { routeInput } from "../dist/src/gateway.js";
import { SystemTmuxExecutor } from "../dist/src/tmux.js";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const iterationsIndex = process.argv.indexOf("--iterations");
const iterations = iterationsIndex === -1 ? 30 : Number(process.argv[iterationsIndex + 1]);
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex === -1 ? undefined : path.resolve(process.argv[outputIndex + 1]);
if (!Number.isInteger(iterations) || iterations < 5 || iterations > 500) throw new Error("iterations must be in [5, 500]");

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function summary(values) {
  return {
    count: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    rawMs: values,
  };
}

async function waitFor(read, ready, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function commandOutput(command, args = []) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

const root = await mkdtemp(path.join(os.tmpdir(), "intentd-ish-eval-"));
const socketPath = path.join(root, "intentd.sock");
const stateDir = path.join(root, "state");
const runtimeDir = path.join(root, "runtime");
const binDir = path.join(root, "bin");
const zdotdir = path.join(root, "zdot");
const actionFile = path.join(root, "action-results.txt");
const baselineFile = path.join(root, "baseline-results.txt");
const restartFile = path.join(root, "restart-results.txt");
const tmuxSocket = `intentd-ish-eval-${process.pid}-${Date.now()}`;
const executor = new SystemTmuxExecutor(tmuxSocket);
const fakePi = path.join(sourceRoot, "dist", "test", "fixtures", "fake-pi.js");
const daemonOptions = { socketPath, stateDir, runner: { command: process.execPath, args: [fakePi] } };
let daemon = new IntentDaemon(daemonOptions);

try {
  await Promise.all([mkdir(binDir), mkdir(zdotdir), mkdir(runtimeDir)]);
  const wrapper = path.join(binDir, "ishctl");
  await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(sourceRoot, "dist", "src", "ctl-cli.js"))} "$@"\n`);
  await chmod(wrapper, 0o755);
  await writeFile(
    path.join(zdotdir, ".zshrc"),
    [
      `export PATH=${JSON.stringify(`${binDir}:${process.env.PATH ?? ""}`)}`,
      `export INTENTD_SOCKET=${JSON.stringify(socketPath)}`,
      `export INTENTD_STATE_DIR=${JSON.stringify(stateDir)}`,
      `export ISH_RUNTIME_DIR=${JSON.stringify(runtimeDir)}`,
      `source ${JSON.stringify(path.join(sourceRoot, "shell", "ish.zsh"))}`,
      `PROMPT='EVAL> '`,
    ].join("\n") + "\n",
  );

  await daemon.start();
  const envArgs = ["env", `ZDOTDIR=${zdotdir}`, `HOME=${root}`, `PATH=${binDir}:${process.env.PATH ?? ""}`, "zsh", "-d"];
  await executor.run(["-f", "/dev/null", "new-session", "-d", "-s", "eval", ...envArgs]);
  await executor.run(["split-window", "-d", "-t", "eval:0", ...envArgs]);
  const client = new IntentClient(socketPath);
  const capsules = await waitFor(
    () => client.listCapsules(),
    (value) => value.length === 2 && value.every((item) => item.mode === "prompt" && item.generation >= 1),
    "two shell capsules",
  );

  const routingStart = performance.now();
  for (let index = 0; index < 100_000; index += 1) {
    routeInput(index % 2 ? "ls -la" : "why is nginx failing?", { commandExists: (command) => command === "ls" });
  }
  const routingElapsedMs = performance.now() - routingStart;

  const actionLatencies = [];
  for (let index = 0; index < iterations; index += 1) {
    const before = new Map((await client.listCapsules()).map((item) => [item.id, item.generation]));
    const start = performance.now();
    const action = await client.createAction({
      selector: "session:eval",
      command: `print -r -- action-${index} >> ${JSON.stringify(actionFile)}`,
      effectClass: "effectful",
    });
    await client.dispatchAction(action.id);
    await waitFor(() => client.getAction(action.id), (value) => value.status === "succeeded", `action ${index}`);
    actionLatencies.push(performance.now() - start);
    await waitFor(
      () => client.listCapsules(),
      (value) => value.every((item) => item.generation > before.get(item.id)),
      `action ${index} generation advance`,
    );
  }

  const baselineLatencies = [];
  for (let index = 0; index < iterations; index += 1) {
    const expectedLines = (index + 1) * 2;
    const before = new Map((await client.listCapsules()).map((item) => [item.id, item.generation]));
    const start = performance.now();
    for (const item of capsules) {
      const command = `print -r -- baseline-${index} >> ${JSON.stringify(baselineFile)}`;
      await executor.run(["send-keys", "-t", item.pane, "-l", "--", command]);
      await executor.run(["send-keys", "-t", item.pane, "Enter"]);
    }
    await waitFor(
      async () => (await readFile(baselineFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length,
      (lines) => lines === expectedLines,
      `tmux baseline ${index}`,
    );
    baselineLatencies.push(performance.now() - start);
    await waitFor(
      () => client.listCapsules(),
      (value) => value.every((item) => item.generation > before.get(item.id) && item.mode === "prompt"),
      `tmux baseline ${index} generation advance`,
    );
  }

  const scopedBefore = new Map((await client.listCapsules()).map((item) => [item.id, item.generation]));
  const scopedAction = await client.createAction({
    selector: "session:eval",
    command: "print -r -- capsule=$_ISH_CAPSULE_ID cwd=$PWD zsh=$ZSH_VERSION",
    effectClass: "observation",
  });
  await client.dispatchAction(scopedAction.id);
  const scopedEvidence = await waitFor(
    () => client.getAction(scopedAction.id),
    (value) => value.status === "succeeded",
    "scoped evidence action",
  );
  await waitFor(
    () => client.listCapsules(),
    (value) => value.every((item) => item.generation > scopedBefore.get(item.id)),
    "scoped evidence generation advance",
  );

  const typed = capsules[0];
  await executor.run(["send-keys", "-t", typed.pane, "-l", "PRESERVED_BY_EVALUATION"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const partialAction = await client.createAction({ selector: "session:eval", command: "print -r -- scoped-output", effectClass: "observation" });
  await client.dispatchAction(partialAction.id);
  const partial = await waitFor(
    () => client.getAction(partialAction.id),
    (value) => value.status === "partial" || value.status === "failed",
    "typed-buffer partial result",
  );
  const typedPane = await executor.run(["capture-pane", "-p", "-t", typed.pane]);
  await executor.run(["send-keys", "-t", typed.pane, "C-c"]);
  await waitFor(
    () => client.listCapsules(),
    (value) =>
      value.every((item) => {
        const planned = partialAction.targets.find((target) => target.capsuleId === item.id);
        return planned && item.generation > planned.expectedGeneration && item.mode === "prompt";
      }),
    "capsules after typed input",
  );

  const inFlight = await client.createAction({
    selector: "session:eval",
    command: `sleep 0.8; print -r -- restart-once >> ${JSON.stringify(restartFile)}`,
    effectClass: "effectful",
  });
  await client.dispatchAction(inFlight.id);
  await waitFor(
    () => client.getAction(inFlight.id),
    (value) => value.targets.every((item) => item.state === "running"),
    "all targets executing",
  );
  await daemon.stop(false);
  daemon = new IntentDaemon(daemonOptions);
  await daemon.start();
  const restartClient = new IntentClient(socketPath);
  const atRestart = await restartClient.getAction(inFlight.id);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterRestart = await restartClient.getAction(inFlight.id);
  const restartLines = (await readFile(restartFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const activeAfterRestart = await restartClient.listCapsules();

  const actionLines = (await readFile(actionFile, "utf8")).trim().split("\n").filter(Boolean);
  const baselineLines = (await readFile(baselineFile, "utf8")).trim().split("\n").filter(Boolean);
  const report = {
    schema: "intentd-ish-linux-evaluation/v1",
    generatedAt: new Date().toISOString(),
    environment: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
      zsh: commandOutput("zsh", ["--version"]),
      tmux: commandOutput("tmux", ["-V"]),
      kernel: commandOutput("uname", ["-a"]),
    },
    routing: { iterations: 100_000, elapsedMs: routingElapsedMs, meanMicroseconds: (routingElapsedMs * 1000) / 100_000 },
    capsuleFanout: summary(actionLatencies),
    tmuxTextBroadcast: summary(baselineLatencies),
    correctness: {
      capsuleCount: capsules.length,
      actionExpectedLines: iterations * 2,
      actionObservedLines: actionLines.length,
      baselineExpectedLines: iterations * 2,
      baselineObservedLines: baselineLines.length,
      partialStatus: partial.status,
      partialTargetStates: partial.targets.map((item) => item.state),
      typedInputPreserved: typedPane.stdout.includes("PRESERVED_BY_EVALUATION"),
      restartImmediateStatus: atRestart.status,
      restartSettledStatus: afterRestart.status,
      restartEffectLines: restartLines.length,
      activeCapsulesAfterRestart: activeAfterRestart.length,
      scopedEvidence: scopedEvidence.targets.map((item) => ({ capsuleId: item.capsuleId, state: item.state, output: item.output })),
    },
  };
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await daemon.stop(false).catch(() => {});
  await executor.run(["kill-server"]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
