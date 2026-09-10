import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createProjectSeedScript } from "./project-seed-script.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const url = "https://github.com/openclaw/synthetic-preparation.git";
const token = "synthetic-inherited-project-token";

async function fixture(fail = false) {
  const root = await fs.realpath(tempDirs.make("project-seed-script-"));
  const home = path.join(root, "home's directory");
  const repository = path.join(root, "source");
  const bin = path.join(root, "bin");
  await Promise.all([home, repository, bin].map((dir) => fs.mkdir(dir)));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const git = (cwd: string, args: string[]) =>
    execFileSync(realGit, ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  const codeWitness = path.join(root, "repository-code-ran");
  const setupScript = `#!/bin/sh\nprintf 'unexpected setup execution\\n' > '${codeWitness}'\nexit 97\n`;
  await fs.mkdir(path.join(repository, ".openclaw"));
  await fs.writeFile(path.join(repository, ".openclaw", "worktree-setup.sh"), setupScript, {
    mode: 0o755,
  });
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Seed Test"]);
  git(repository, ["config", "user.email", "seed@example.invalid"]);
  await fs.writeFile(path.join(repository, "input.txt"), "pinned A\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "A"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(repository, "input.txt"), "later B\n");
  git(repository, ["commit", "--quiet", "-am", "B"]);
  await fs.writeFile(path.join(repository, "untracked.txt"), "must not transfer\n");
  const witness = path.join(root, "fetches");
  const askpassWitness = path.join(root, "inherited-askpass-ran");
  const askpass = path.join(bin, "inherited-askpass");
  await fs.writeFile(
    askpass,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(askpassWitness)}, "unexpected inherited authentication");\nprocess.exit(98);\n`,
    { mode: 0o700 },
  );
  // Replace only the network boundary. All object transfer, fsck, checkout and
  // cache-hit verification execute real Git against an independently created repo.
  const shim = path.join(bin, "git");
  await fs.writeFile(
    shim,
    `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("fetch") && args.includes(${JSON.stringify(url)})) {
  assert(args.includes("--depth=1"));
  assert(args.includes("--no-write-fetch-head"));
  assert(args.includes("--no-recurse-submodules"));
  assert(args.includes("http.followRedirects=false"));
  assert(args.includes("protocol.allow=never"));
  assert(args.includes("credential.helper="));
  assert.equal(args.at(-1), ${JSON.stringify(baseCommit)});
  for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_TRACE", "GH_TOKEN", "GITHUB_TOKEN"]) assert.equal(process.env[key], undefined);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, require("node:os").devNull);
  assert.equal(process.env.GIT_ASKPASS, "");
  assert.equal(process.env.SSH_ASKPASS, "");
  assert.equal(process.env.GIT_TERMINAL_PROMPT, "0");
  assert(!args.join(" ").includes(${JSON.stringify(token)}));
  fs.appendFileSync(${JSON.stringify(witness)}, "fetch\\n");
  if (${fail}) {
    fs.writeSync(2, "synthetic remote fetch diagnostic\\n".repeat(20000));
    process.exit(17);
  }
  args.splice(args.indexOf(${JSON.stringify(url)}), 1, ${JSON.stringify(repository)});
  args.unshift("-c", "protocol.file.allow=always");
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  const input = { namespace: "gateway", seedKey: "a".repeat(64), baseCommit };
  const run = (extra?: Parameters<typeof createProjectSeedScript>[0]["repository"]) =>
    spawnSync("sh", ["-c", createProjectSeedScript({ ...input, repository: extra })], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GIT_ASKPASS: askpass,
        SSH_ASKPASS: askpass,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "unwanted-helper",
        GIT_TRACE: "1",
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
      },
    });
  const inspection = run();
  expect(inspection.status, inspection.stderr).toBe(0);
  const { directory } = JSON.parse(inspection.stdout) as { directory: string };
  return {
    directory,
    repository,
    git,
    witness,
    codeWitness,
    askpassWitness,
    setupScript,
    run,
    transport: { directory, url },
    seed: path.join(path.dirname(directory), input.seedKey),
    baseCommit,
  };
}

describe("public repository project seeds", () => {
  it("installs only the pinned Git objects without inherited authentication or executing repository code, then reuses them offline", async () => {
    const f = await fixture();
    const result = f.run(f.transport);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ready: true });
    expect(await fs.readFile(path.join(f.seed, "input.txt"), "utf8")).toBe("pinned A\n");
    expect((await fs.readdir(f.seed)).toSorted()).toEqual([".git", ".openclaw", "input.txt"]);
    expect(await fs.readFile(path.join(f.seed, ".openclaw", "worktree-setup.sh"), "utf8")).toBe(
      f.setupScript,
    );
    expect(f.git(f.seed, ["rev-parse", "HEAD"])).toBe(f.baseCommit);
    expect(f.git(f.seed, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(f.git(f.seed, ["remote", "get-url", "origin"])).toBe(url);
    expect(f.git(f.seed, ["status", "--porcelain"])).toBe("");
    expect(await fs.readFile(path.join(f.seed, ".git", "config"), "utf8")).not.toContain(token);
    await expect(fs.stat(path.join(f.seed, ".git", "FETCH_HEAD"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rename(f.repository, `${f.repository}-offline`);
    const hit = f.run();
    expect(hit.status, hit.stderr).toBe(0);
    expect(JSON.parse(hit.stdout)).toEqual({ ready: true });
    expect(await fs.readFile(f.witness, "utf8")).toBe("fetch\n");
    await expect(fs.stat(f.codeWitness)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(f.askpassWitness)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a bounded generic failure and removes staging when public fetch emits excessive diagnostics", async () => {
    const f = await fixture(true);
    const result = f.run(f.transport);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Project repository fetch failed\n");
    expect(result.stdout).toBe("");
    expect(await fs.readFile(f.witness, "utf8")).toBe("fetch\n");
    expect(await fs.readdir(path.dirname(f.directory))).toEqual([]);
    await expect(fs.stat(f.codeWitness)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(f.askpassWitness)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
