import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { prepareNodeWorkspaceTransferSnapshot } from "./node-workspace-transfer-snapshot.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["completed", "receiving"] as const)(
  "disposes an abandoned %s publication upload before the next checkpoint",
  async (boundary) => {
    const root = tempDirs.make("node-publication-disposal-");
    const workspaceDir = path.join(root, "worker");
    const home = path.join(root, "home");
    const temporaryRoot = path.join(root, "transfers");
    await fs.mkdir(workspaceDir);
    const exec = async (argv: string[]) => {
      const result = await runCommandWithTimeout(argv, {
        cwd: workspaceDir,
        timeoutMs: 10_000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: home,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
      return { ...result, workspaceDir };
    };
    await exec(["git", "init", "--quiet"]);
    await fs.writeFile(path.join(workspaceDir, "result.txt"), "base\n");
    await exec(["git", "add", "result.txt"]);
    await exec([
      "git",
      "-c",
      "user.name=Publication Test",
      "-c",
      "user.email=publication@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    const base = await prepareNodeWorkspaceTransferSnapshot({
      localPath: workspaceDir,
      temporaryRoot: root,
    });
    if (!base.manifest.baseCommit) {
      throw new Error("Repository fixture has no base commit");
    }
    const manifests = path.join(home, ".openclaw-worker", "manifests");
    await fs.mkdir(manifests, { recursive: true });
    await fs.writeFile(path.join(manifests, `${base.manifestRef.slice(7)}.json`), base.rawManifest);
    await fs.writeFile(path.join(workspaceDir, "result.txt"), "checkpoint edit\n");
    const owner = new AbortController();
    const service = createNodeWorkspaceTransferService({
      temporaryRoot,
      getOwner: () => ({
        credential: { ownerEpoch: 1, sessionId: "session" },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    const receiving = createDeferred();
    const release = createDeferred();
    const checkpointPrepared = createDeferred();
    let publicationActive = false;
    let failPublication = true;
    let blocked = false;
    let uploadOutcome: Promise<"completed" | "rejected"> | undefined;
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (
        boundary === "receiving" &&
        publicationActive &&
        !blocked &&
        typeof args[0] === "string" &&
        path.basename(args[0]).startsWith("upload-")
      ) {
        blocked = true;
        receiving.resolve();
        await release.promise;
      }
      return await realpath(...args);
    });
    const actions = createNodeWorkerWorkspaceActions({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      ownerSignal: owner.signal,
      isOwnerCurrent: () => !owner.signal.aborted,
      restoredWorkspace: {
        source: {
          kind: "repository",
          baseCommit: base.manifest.baseCommit,
          baseManifestRef: base.manifestRef,
        },
        manifestRef: base.manifestRef,
        remoteWorkspaceDir: workspaceDir,
      },
      workspaceTransfer: service,
      runWorkspaceCommand: async (command) => {
        if (!command.transfer) {
          return await exec([...command.argv]);
        }
        const publication =
          command.transfer.direction === "upload" &&
          Boolean(command.transfer.publicationBaseCommit);
        publicationActive = publication && failPublication;
        const upload = runNodeWorkerWorkspaceTransfer({
          gatewayUrl: server.gatewayUrl,
          environmentId: "environment",
          workspaceDir,
          manifestHome: home,
          transfer: command.transfer,
        });
        if (publicationActive) {
          uploadOutcome = upload.then(
            () => "completed",
            () => "rejected",
          );
          if (boundary === "receiving") {
            await withTestTimeout(receiving.promise, 5_000, "publication never reached staging");
          } else {
            expect(await uploadOutcome).toBe("completed");
          }
          // The data channel can outlive a lost control-channel command result.
          return {
            workspaceDir,
            stdout: "",
            stderr: "control channel lost its result",
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }
        return {
          workspaceDir,
          stdout: await upload,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      },
    });
    const checkpoint = vi.fn(async (payload: { stagingRoot: string }) => {
      expect(await fs.readFile(path.join(payload.stagingRoot, "result.txt"), "utf8")).toBe(
        "checkpoint edit\n",
      );
      checkpointPrepared.resolve();
      return { verify: async () => {}, publish: async () => {}, discard: async () => {} };
    });
    const reconcile = () =>
      actions.reconcileWorkspace({
        remoteWorkspaceDir: workspaceDir,
        baseManifestRef: base.manifestRef,
        source: {
          kind: "repository",
          referenceManifestRef: base.manifestRef,
          prepareCheckpoint: checkpoint,
        },
      });
    let first: ReturnType<typeof reconcile> | undefined;
    try {
      await actions.validateRestoredWorkspace();
      first = reconcile();
      if (boundary === "receiving") {
        let settled = false;
        void first.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await withTestTimeout(checkpointPrepared.promise, 5_000, "checkpoint was not prepared");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(settled, "reconciliation must join abandoned staging work").toBe(false);
        release.resolve();
      }
      expect((await first).changed).toBe(true);
      if (boundary === "receiving") {
        expect(await uploadOutcome).toBe("rejected");
      }
      expect(
        (await fs.readdir(temporaryRoot, { recursive: true })).filter((entry) =>
          path.basename(entry).startsWith("upload-"),
        ),
      ).toEqual([]);
      failPublication = false;
      expect((await reconcile()).changed).toBe(true);
      expect(checkpoint).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await first?.catch(() => undefined);
      await uploadOutcome;
      await service.closeAll();
      await server.close();
    }
  },
);
