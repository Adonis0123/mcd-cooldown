import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("global git install works without tsc and setup uses that absolute path", { timeout: 120_000 }, () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    files?: string[];
    scripts?: Record<string, string>;
  };
  for (const name of ["prepare", "prepack", "build", "install", "preinstall", "postinstall"]) {
    assert.equal(pkg.scripts?.[name], undefined, name);
  }
  const stage = mkdtempSync(join(tmpdir(), "mcd-git-stage-"));
  const prefix = mkdtempSync(join(tmpdir(), "mcd-git-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "mcd-git-home-"));
  try {
    cpSync(join(root, "package.json"), join(stage, "package.json"));
    for (const entry of pkg.files ?? []) {
      const from = join(root, entry);
      if (!existsSync(from)) continue;
      cpSync(from, join(stage, entry), { recursive: true });
    }
    git(stage, ["init"]);
    git(stage, ["config", "user.email", "dev@example.com"]);
    git(stage, ["config", "user.name", "mcd-test"]);
    git(stage, ["add", "-A"]);
    git(stage, ["commit", "-m", "stage"]);
    const installed = spawnSync(npmBin(), ["install", "-g", "--prefix", prefix, `git+file://${stage}`], {
      encoding: "utf8",
      env: cleanEnv(),
      timeout: 90_000,
    });
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
    const bin = join(prefix, "bin", "mcd-cooldown");
    assert.equal(existsSync(bin), true);
    const version = spawnSync(bin, ["version"], { encoding: "utf8", env: cleanEnv() });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^1\.0\.0\n/);

    const cliPath = installedCli(prefix);
    assert.equal(lstatSync(join(prefix, "lib", "node_modules", "mcd-cooldown")).isDirectory(), true);
    assert.equal(realpathSync(bin), cliPath);
    assert.ok(cliPath.startsWith(realpathSync(prefix)), cliPath);

    const settings = join(home, "missing.json");
    const printed = spawnSync(bin, ["setup", "claude", "--print", "--settings", settings], {
      encoding: "utf8",
      env: cleanEnv({ HOME: home, MCD_HOME: join(home, "mcd"), MCD_MCP_TOKEN: "" }),
    });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(existsSync(settings), false);
    const help = spawnSync(bin, ["--help"], { encoding: "utf8", env: cleanEnv() });
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout.indexOf("三步开始") >= 0 && help.stdout.indexOf("三步开始") < help.stdout.indexOf("其他命令"));
    assert.match(help.stdout, /mcd-cooldown token/);
    assert.match(help.stdout, /mcd-cooldown init && mcd-cooldown setup claude/);
    assert.match(help.stdout, /0600/);
    assert.match(help.stdout, /非麦当劳官方产品/);
    assert.match(help.stdout, /默认只核价，不会自动下单/);
    assert.equal(help.stdout.includes(cliPath), false);
    const helpViaNode = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8", env: cleanEnv() });
    assert.equal(helpViaNode.status, 0, helpViaNode.stderr);
    assert.match(helpViaNode.stdout, /mcd-cooldown token/);
    assert.equal(helpViaNode.stdout.includes(cliPath), false);
    const body = JSON.parse(printed.stdout) as {
      statusLine: { command: string };
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.equal(body.statusLine.command, `node ${cliPath} statusline`);
    assert.equal(body.hooks.Stop[0]?.hooks[0]?.command, `node ${cliPath} hook`);
    const status = spawnSync(process.execPath, [cliPath, "statusline"], {
      encoding: "utf8",
      input: "{}\n",
      env: cleanEnv({
        HOME: home,
        MCD_HOME: join(home, "mcd"),
        MCD_MCP_TOKEN: "",
        MCD_MCP_URL: "http://127.0.0.1:9",
        MCD_NOW: "2026-10-21T01:30:00.000Z",
      }),
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /还没选门店和常点/);
    assert.match(status.stdout, /mcd-cooldown init/);
    assert.equal(status.stdout.includes(cliPath), false);
    assert.equal(status.stdout.includes("待命"), false);
    const init = spawnSync(process.execPath, [cliPath, "init"], {
      encoding: "utf8",
      env: cleanEnv({
        HOME: home,
        MCD_HOME: join(home, "mcd"),
        MCD_MCP_TOKEN: "",
      }),
    });
    assert.notEqual(init.status, 0);
    assert.match(init.stderr, /mcd-cooldown token/);
    assert.match(init.stderr, /mcd-cooldown init/);
    assert.equal(init.stderr.includes(cliPath), false);
    const ready = spawnSync(
      process.execPath,
      [cliPath, "init", "--mock", "--meals", "--city", "示例市", "--keyword", "示例路", "--store", "SAMPLE-STORE", "--item", "SAMPLE-001", "--item", "2"],
      {
        encoding: "utf8",
        env: cleanEnv({
          HOME: home,
          MCD_HOME: join(home, "mcd"),
          MCD_MCP_TOKEN: "",
        }),
      },
    );
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /下一步：mcd-cooldown setup claude/);
    assert.match(ready.stdout, /mcd-cooldown meals weekends on/);
    assert.equal(ready.stdout.includes(cliPath), false);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

function npmBin(): string {
  return process.env.MCD_TEST_NPM?.trim() || "npm";
}

function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
}

function installedCli(prefix: string): string {
  const candidates = [
    join(prefix, "lib/node_modules/mcd-cooldown/dist/src/cli.js"),
    join(prefix, "node_modules/mcd-cooldown/dist/src/cli.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`installed cli not found under ${prefix}`);
}
