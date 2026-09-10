import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";

const execFile = promisify(execFileCallback);

export async function prepareMatrixMentionProgressGate(
  context: Pick<MatrixQaScenarioContext, "gatewayWorkspaceDir">,
) {
  if (!context.gatewayWorkspaceDir) {
    throw new Error("Matrix mention-safety progress requires a Gateway workspace directory.");
  }
  const gatePath = path.join(context.gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
  await rm(gatePath, { force: true });
  await execFile("mkfifo", [gatePath]);
  const gate = await open(gatePath, constants.O_RDWR);
  let closed = false;
  let released = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await gate.close();
  };
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    try {
      await gate.writeFile("matrix-progress-observed\n", "utf8");
    } finally {
      await close();
    }
  };
  const cleanup = async () => {
    try {
      await release();
    } finally {
      await close().catch(() => undefined);
      await rm(gatePath, { force: true });
    }
  };
  return {
    release,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}
