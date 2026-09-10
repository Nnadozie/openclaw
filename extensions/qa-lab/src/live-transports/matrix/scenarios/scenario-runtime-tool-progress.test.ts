import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME } from "./scenario-runtime-shared.js";
import { prepareMatrixMentionProgressGate } from "./scenario-runtime-tool-progress-gate.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("Matrix mention progress gate", () => {
  it("releases and removes the FIFO during failure cleanup without a waiting reader", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    await gate.cleanup();

    await expect(access(gatePath)).rejects.toThrow();
  });

  it("delivers the release marker before removing the FIFO", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });
    const marker = readFile(gatePath, "utf8");

    await gate.release();

    await expect(marker).resolves.toBe("matrix-progress-observed\n");
    await gate.cleanup();
    await expect(access(gatePath)).rejects.toThrow();
  });
});
