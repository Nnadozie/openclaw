import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";

const execFile = promisify(execFileCallback);

export async function prepareMatrixMentionProgressGate(
  context: Pick<MatrixQaScenarioContext, "gatewayWorkspaceDir">,
  options: { releaseTimeoutMs?: number } = {},
) {
  if (!context.gatewayWorkspaceDir) {
    throw new Error("Matrix mention-safety progress requires a Gateway workspace directory.");
  }
  const gatePath = path.join(context.gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
  const releaseTimeoutMs = options.releaseTimeoutMs ?? 10_000;
  await rm(gatePath, { force: true });
  await execFile("mkfifo", [gatePath]);
  let closed = false;
  let releaseError: Error | undefined;
  let releasePromise: Promise<void> | undefined;
  const release = async () => {
    if (releaseError) {
      throw releaseError;
    }
    if (!releasePromise) {
      releasePromise = writeFile(gatePath, "matrix-progress-observed\n", "utf8");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        releasePromise.then(() => "released" as const),
        new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), releaseTimeoutMs);
        }),
      ]);
      if (outcome === "released") {
        return;
      }
      const drain = await open(gatePath, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        await releasePromise;
      } finally {
        await drain.close();
      }
      releaseError = new Error(
        `Matrix mention progress FIFO had no reader after ${releaseTimeoutMs}ms.`,
      );
      throw releaseError;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
  const cleanup = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      if (releasePromise) {
        await releasePromise;
      } else {
        await Promise.all([readFile(gatePath), release()]);
      }
    } finally {
      await rm(gatePath, { force: true });
    }
  };
  return {
    release,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}
