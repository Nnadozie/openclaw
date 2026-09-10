import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { prepareMatrixMentionProgressGate } from "./scenario-runtime-tool-progress-gate.js";
import { runToolProgressMentionSafetyScenario } from "./scenario-runtime-tool-progress.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("skips the FIFO-backed mention progress scenario on Windows", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    await expect(
      runToolProgressMentionSafetyScenario({} as MatrixQaScenarioContext),
    ).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: "Matrix tool progress mention safety requires POSIX FIFO support.",
    });
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
});

describe.skipIf(process.platform === "win32")("Matrix mention progress gate", () => {
  it("releases and removes the FIFO during failure cleanup without a waiting reader", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });

    await gate.cleanup();

    await expect(access(gatePath)).rejects.toThrow();
  });

  it("fails boundedly when no FIFO reader opens", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
    const gate = await prepareMatrixMentionProgressGate(
      { gatewayWorkspaceDir },
      { releaseTimeoutMs: 25 },
    );

    await expect(gate.release()).rejects.toThrow("had no reader after 25ms");
    await gate.cleanup();
    await expect(access(gatePath)).rejects.toThrow();
  });

  it("keeps an early release pending until the FIFO reader opens", async () => {
    const gatewayWorkspaceDir = tempDirs.make("matrix-progress-gate-");
    const gatePath = path.join(gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_MENTION_FILENAME);
    const gate = await prepareMatrixMentionProgressGate({ gatewayWorkspaceDir });
    const release = gate.release();
    const marker = await readFile(gatePath, "utf8");

    await release;

    expect(marker).toBe("matrix-progress-observed\n");
    await gate.cleanup();
    await expect(access(gatePath)).rejects.toThrow();
  });
});
