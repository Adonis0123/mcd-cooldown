import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureHttpHandler } from "../src/mcp/fixture-http.js";
import { listenLoopback } from "../src/mcp/http.js";
import { normalizeHiddenInput } from "../src/secret-input.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const sampleToken = "fixture-token-0123456789";

function run(args: string[], env: NodeJS.ProcessEnv, input?: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test("meal reminder shows on the statusline and ate clears it", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-meals-"));
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_NOW: "2026-10-12T03:50:00.000Z" };
  const on = await run(["meals", "on"], env);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /饭点提醒已开/);
  const line = await run(["statusline"], env);
  assert.equal(line.code, 0, line.stderr);
  assert.match(line.stdout, /午饭时间/);
  assert.match(line.stdout, /读不到 Token/);
  assert.match(line.stdout, /\btoken\b/);
  assert.equal(line.stdout.includes("现在确认"), false);
  const ate = await run(["ate"], env);
  assert.equal(ate.code, 0, ate.stderr);
  const after = await run(["statusline"], env);
  assert.equal(after.stdout.includes("午饭"), false);
});

test("demo, mock doctor, and loopback refusal work from the cli", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-"));
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_NOW: "2026-10-10T13:20:00.000Z" };
  const demo = await run(["demo"], env);
  assert.equal(demo.code, 0);
  assert.match(demo.stdout, /只核价，未下单/);
  const doctor = await run(["doctor", "--mock"], env);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /样例服务/);
  assert.match(doctor.stdout, /没有下单/);
  const exposed = await run(["serve", "--host", "0.0.0.0"], env);
  assert.notEqual(exposed.code, 0);
  assert.match(exposed.stderr, /127\.0\.0\.1/);
});

test("real plan and doctor reject a SAMPLE store left by init --mock", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-sample-"));
  const token = "plan-fixture-token";
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      store: { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "样例", items: [{ productCode: "SAMPLE-001", quantity: 1 }] },
    }),
  );
  const env = {
    ...process.env,
    MCD_HOME: home,
    MCD_MCP_TOKEN: token,
    MCD_MCP_URL: "http://127.0.0.1:1",
    MCD_NOW: "2026-10-14T05:20:00.000Z",
  };
  const plan = await run(["plan"], env);
  assert.notEqual(plan.code, 0);
  assert.match(plan.stderr, /init --mock/);
  assert.match(plan.stderr, /样例门店/);
  assert.match(plan.stderr, /SAMPLE-STORE/);
  assert.match(plan.stderr, /真实 Token/);
  assert.equal(plan.stderr.includes(token), false);
  assert.equal(plan.stdout.includes(token), false);

  const doctor = await run(["doctor"], env);
  assert.notEqual(doctor.code, 0);
  const doctorText = `${doctor.stdout}\n${doctor.stderr}`;
  assert.match(doctorText, /init --mock/);
  assert.match(doctorText, /样例门店/);
  assert.equal(doctorText.includes(token), false);

  const mockPlan = await run(["plan", "--mock"], env);
  assert.equal(mockPlan.code, 0, mockPlan.stderr);
  assert.equal(mockPlan.stdout.includes(token), false);
  assert.equal(mockPlan.stderr.includes("样例门店"), false);

  const mockDoctor = await run(["doctor", "--mock"], { ...env, MCD_MCP_TOKEN: "" });
  assert.equal(mockDoctor.code, 0, mockDoctor.stderr);
  assert.equal(mockDoctor.stdout.includes("样例门店（SAMPLE-STORE）"), false);
});

test("morning plan exits 0 and says the saved meal is ready", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-breakfast-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      store: { storeCode: "1400123", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "午饭", items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }] },
    }),
  );
  const env = {
    ...process.env,
    MCD_HOME: home,
    MCD_MCP_TOKEN: "",
    MCD_NOW: "2026-10-14T00:30:00.000Z",
  };
  const plan = await run(["plan", "--mock"], env);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /早餐时段正餐还没开卖，午饭 12:00 前会提前核价/);
  assert.equal((plan.stdout.match(/核价/g) ?? []).length, 1);
  assert.equal(plan.stdout.includes("确认"), false);
  assert.equal(plan.stdout.includes("现在只是核价"), false);
  assert.equal(plan.stdout.includes("换一份"), false);
  assert.equal(plan.stdout.includes("重新跑 init 换"), false);

  const nearLunch = await run(["plan", "--mock"], { ...env, MCD_NOW: "2026-10-14T03:50:00.000Z" });
  assert.equal(nearLunch.code, 0, nearLunch.stderr);
  assert.match(nearLunch.stdout, /重新跑 init 换一份/);
  assert.equal(nearLunch.stdout.includes("门店和常点已经就绪"), false);
});

test("breakfast quota hook and plan stay short when nothing is waiting", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-breakfast-quota-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      meals: { lunch: "12:00", dinner: "18:30" },
      store: { storeCode: "1400123", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "午饭", items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }] },
    }),
  );
  const now = "2026-10-23T01:50:00.000Z";
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_NOW: now };
  const resetsAt = Date.parse(now) / 1000 + 40 * 60;
  const raw = `${JSON.stringify({ rate_limits: { five_hour: { used_percentage: 95, resets_at: resetsAt } } })}\n`;
  const hook = await run(["hook", "--mock"], env, raw);
  assert.equal(hook.code, 0, hook.stderr);
  assert.equal(
    hook.stdout,
    "额度约 40 分钟后恢复，起来活动一下。早餐时段正餐还没开卖，午饭 12:00 前会提前核价。程序没有下单。\n",
  );
  assert.equal(hook.stdout.includes("确认"), false);

  const plan = await run(["plan", "--mock"], env);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(
    plan.stdout,
    "约 40 分钟后恢复\n起来活动一下。\n早餐时段正餐还没开卖，午饭 12:00 前会提前核价。\n",
  );
  assert.equal(plan.stdout.includes("确认"), false);
  assert.equal((plan.stdout.match(/核价/g) ?? []).length, 1);
});

test("a priced quota hook still prints the confirm command", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-priced-quota-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      store: { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] },
    }),
  );
  const now = "2026-10-23T01:50:00.000Z";
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_NOW: now };
  const resetsAt = Date.parse(now) / 1000 + 40 * 60;
  const raw = `${JSON.stringify({ rate_limits: { five_hour: { used_percentage: 95, resets_at: resetsAt } } })}\n`;
  const hook = await run(["hook", "--mock"], env, raw);
  assert.equal(hook.code, 0, hook.stderr);
  assert.match(hook.stdout, /建议 10:10 前确认。到店自取，起身活动一下。现在只是核价。/);
  assert.match(hook.stdout, /要下单请在本机执行 .+ confirm [0-9a-f]{8}/);
  assert.equal(hook.stdout.includes("早餐时段"), false);
  assert.equal(hook.stdout.includes("程序没有下单"), false);

  const plan = await run(["plan", "--mock"], env);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /建议 10:10 前确认。到店自取，起身活动一下。现在只是核价。/);
  assert.match(plan.stdout, /confirm [0-9a-f]{8}/);
});

test("a failed quote with no pending request does not ask you to confirm", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-closed-quota-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      store: { storeCode: "CLOSED-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] },
    }),
  );
  const now = "2026-10-23T01:50:00.000Z";
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_NOW: now };
  const resetsAt = Date.parse(now) / 1000 + 40 * 60;
  const raw = `${JSON.stringify({ rate_limits: { five_hour: { used_percentage: 95, resets_at: resetsAt } } })}\n`;
  const hook = await run(["hook", "--mock"], env, raw);
  assert.equal(hook.code, 0, hook.stderr);
  assert.match(hook.stdout, /额度约 40 分钟后恢复，起来活动一下/);
  assert.equal(hook.stdout.includes("确认"), false);
  assert.equal(hook.stdout.includes("现在只是核价"), false);
  const plan = await run(["plan", "--mock"], env);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /门店当前不营业/);
  assert.match(plan.stdout, /起来活动一下/);
  assert.equal(plan.stdout.includes("确认"), false);
  assert.equal(plan.stdout.includes("建议"), false);
});

test("stdio guard holds create-order and confirm submits it once", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-stdio-"));
  const handler = fixtureHttpHandler();
  const server = await listenLoopback(handler);
  const token = "stdio-token-value";
  const env = {
    ...process.env,
    MCD_HOME: home,
    MCD_MCP_URL: server.url,
    MCD_MCP_TOKEN: token,
    MCD_NOW: "2026-10-10T13:20:00.000Z",
  };
  const child = spawn(process.execPath, [cli, "guard"], { env, stdio: ["pipe", "pipe", "pipe"] });
  if (!child.stdin || !child.stdout) throw new Error("stdio was not piped");
  const lines = createInterface({ input: child.stdout });
  const queue: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  lines.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
      return;
    }
    queue.push(line);
  });
  const next = () => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve) => {
      waiter = resolve;
    });
  };
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    const init = JSON.parse(await next()) as { result?: { instructions?: string } };
    assert.match(init.result?.instructions ?? "", /不要向用户索取/);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create-order", arguments: { storeCode: "SAMPLE-STORE", beCode: "SAMPLE-BE", beType: 1, takeWayCode: "1", items: [{ productCode: "SAMPLE-001", quantity: 1 }] } } })}\n`);
    const held = await next();
    assert.match(held, /未向麦当劳提交/);
    assert.equal(held.includes(token), false);
    assert.equal(stderr.includes(token), false);
    assert.equal(handler.backend.called("create-order"), 0);
    const id = /请求号：([a-f0-9]{8})/.exec(held)?.[1];
    assert.ok(id);
    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const confirmed = await run(["confirm", id, "--allow-quiet"], env);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /SAMPLE-ORDER-1/);
    assert.equal(confirmed.stdout.includes(token), false);
    assert.equal(handler.backend.called("create-order"), 1);
    assert.equal(handler.observations.bodies.some((body) => body.includes(token)), false);
  } finally {
    lines.close();
    if (child.exitCode == null) child.kill();
    await server.close();
  }
});

test("hidden paste markers are removed before a token is saved", () => {
  assert.equal(normalizeHiddenInput(`\u001b[200~${sampleToken}\u001b[201~`), sampleToken);
});

function runPty(args: string[], env: NodeJS.ProcessEnv, input: string): Promise<{ code: number; output: string }> {
  const script = `
import os, pty, select, sys
cmd = sys.argv[1:]
token = sys.stdin.buffer.read()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out = b""
sent = False
while True:
    ready, _, _ = select.select([fd], [], [], 5)
    if not ready:
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not sent and "粘贴 Token".encode() in out:
        os.write(fd, token if token.endswith(b"\\n") else token + b"\\n")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
raise SystemExit(os.waitstatus_to_exitcode(status))
`;
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", script, process.execPath, cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output: `${output}\n${stderr}` }));
    child.stdin.end(input);
  });
}

test("token command saves from stdin without echoing, and refuses the project directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-token-"));
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "" };
  const file = join(home, "token");
  const saved = await run(["token"], env, `Bearer "${sampleToken}"\n`);
  assert.equal(saved.code, 0, saved.stderr);
  assert.match(saved.stdout, /长度 24/);
  assert.match(saved.stdout, /0600/);
  assert.match(saved.stdout, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(saved.stdout.includes(sampleToken), false);
  assert.equal(saved.stderr.includes(sampleToken), false);
  assert.equal(readFileSync(file, "utf8"), `${sampleToken}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ meals: { enabled: true, timezone: "Asia/Shanghai", lunch: "12:00", dinner: "18:30" } }),
  );
  const fromFile = await run(["statusline"], { ...env, MCD_MCP_TOKEN: "", MCD_NOW: "2026-10-20T03:42:00Z" }, "{}\n");
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.equal(fromFile.stdout.includes("读不到 Token"), false);
  assert.equal(fromFile.stdout.includes(sampleToken), false);
  assert.equal(fromFile.stderr.includes(sampleToken), false);

  const hidden = await runPty(["token"], { ...env, MCD_HOME: join(home, "tty") }, sampleToken);
  assert.equal(hidden.code, 0, hidden.output);
  assert.match(hidden.output, /长度 24/);
  assert.equal(hidden.output.includes(sampleToken), false);
  assert.equal(readFileSync(join(home, "tty", "token"), "utf8"), `${sampleToken}\n`);
  assert.equal(statSync(join(home, "tty", "token")).mode & 0o777, 0o600);

  const cleared = await run(["token", "--clear"], env);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.match(cleared.stdout, /已删除/);
  assert.equal(cleared.stdout.includes(sampleToken), false);
  assert.equal(existsSync(file), false);
  const missing = await run(["token", "--clear"], env);
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stdout, /没有 token 文件/);

  const empty = await run(["token"], env, "\n");
  assert.notEqual(empty.code, 0);
  assert.match(empty.stderr, /没有读到 Token/);
  assert.equal(existsSync(file), false);
  const spaced = `bad ${sampleToken}`;
  const rejected = await run(["token"], env, `${spaced}\n`);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /空白/);
  assert.equal(rejected.stdout.includes(sampleToken), false);
  assert.equal(rejected.stderr.includes(sampleToken), false);
  assert.equal(existsSync(file), false);

  const argvSecret = "fixture-token-argv-not-printed";
  const fromArg = await run(["token", argvSecret], env);
  assert.notEqual(fromArg.code, 0);
  assert.match(fromArg.stderr, /不要写在命令后面/);
  assert.equal(fromArg.stdout.includes(argvSecret), false);
  assert.equal(fromArg.stderr.includes(argvSecret), false);
  assert.equal(existsSync(file), false);

  const project = mkdtempSync(join(tmpdir(), "mcd-proj-"));
  mkdirSync(join(project, ".git"));
  const inside = join(project, "should-not-write-token");
  const blocked = await run(["token"], { ...env, MCD_HOME: inside }, `${sampleToken}\n`, project);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /项目目录/);
  assert.equal(blocked.stdout.includes(sampleToken), false);
  assert.equal(blocked.stderr.includes(sampleToken), false);
  assert.equal(existsSync(join(inside, "token")), false);
  assert.equal(existsSync(inside), false);
});

test("token commands replace or clear a damaged token file", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-token-bad-"));
  const file = join(home, "token");
  const damaged = "tiny";
  writeFileSync(file, `${damaged}\n`, { mode: 0o600 });
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: damaged };
  const cleared = await run(["token", "--clear"], env);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.match(cleared.stdout, /已删除/);
  assert.equal(cleared.stdout.includes(damaged), false);
  assert.equal(cleared.stderr.includes(damaged), false);
  assert.equal(cleared.stderr.includes("太短"), false);
  assert.equal(existsSync(file), false);

  writeFileSync(file, `${damaged}\n`, { mode: 0o600 });
  const replaced = await run(["token"], env, `${sampleToken}\n`);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(replaced.stdout, /长度 24/);
  assert.equal(readFileSync(file, "utf8"), `${sampleToken}\n`);
  assert.equal(replaced.stdout.includes(sampleToken), false);
  assert.equal(replaced.stdout.includes(damaged), false);
  assert.equal(replaced.stderr.includes(sampleToken), false);
  assert.equal(replaced.stderr.includes(damaged), false);
  assert.equal(replaced.stderr.includes("太短"), false);
});

test("statusline and hook explain a missing token instead of a fake confirm", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-notoken-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      meals: { enabled: true, timezone: "Asia/Shanghai", weekends: false, lunch: "12:00", dinner: "18:30", prepMinutes: 20, lingerMinutes: 45, notify: false },
      store: { storeCode: "1400123", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] },
    }),
  );
  const env = { ...process.env, MCD_HOME: home, MCD_NOW: "2026-10-20T03:42:00Z", MCD_MCP_TOKEN: "" };
  const line = await run(["statusline"], env, "{}\n");
  assert.equal(line.code, 0, line.stderr);
  assert.match(line.stdout, /午饭时间/);
  assert.match(line.stdout, /读不到 Token/);
  assert.match(line.stdout, /\btoken\b/);
  assert.equal(line.stdout.includes("现在确认"), false);
  const hook = await run(["hook"], env, "{}\n");
  assert.equal(hook.code, 0, hook.stderr);
  assert.match(hook.stdout, /读不到 Token/);
  assert.match(hook.stdout, /\btoken\b/);
  assert.equal(hook.stdout.includes("现在确认"), false);
  const again = await run(["hook"], env, "{}\n");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.trim(), "");
});

test("a failed quote does not offer confirm, and 60006 keeps a sentence break", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-unpriced-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      meals: { enabled: true, timezone: "Asia/Shanghai", weekends: false, lunch: "12:00", dinner: "18:30", prepMinutes: 20, lingerMinutes: 45, notify: false },
      store: { storeCode: "1400123", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "早餐款", items: [{ productCode: "BREAKFAST-ONLY", quantity: 1 }] },
    }),
  );
  const env = {
    ...process.env,
    MCD_HOME: home,
    MCD_MCP_TOKEN: sampleToken,
    MCD_NOW: "2026-10-20T03:42:00Z",
  };
  const hook = await run(["hook", "--mock"], env, "{}\n");
  assert.equal(hook.code, 0, hook.stderr);
  assert.match(hook.stdout, /核价没成功/);
  assert.match(hook.stdout, /换一份。程序没有下单/);
  assert.equal(hook.stdout.includes("换一份程序"), false);
  assert.equal(hook.stdout.includes("现在确认"), false);
  assert.equal(hook.stdout.includes(sampleToken), false);
  assert.equal(hook.stderr.includes(sampleToken), false);
  const line = await run(["statusline"], env, "{}\n");
  assert.equal(line.code, 0, line.stderr);
  assert.match(line.stdout, /核价没成功/);
  assert.match(line.stdout, /\bplan\b/);
  assert.equal(line.stdout.includes("现在确认"), false);
  assert.equal(line.stdout.includes(sampleToken), false);
});

test("a priced request does not offer confirm after the token disappears", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-lost-token-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      meals: { enabled: true, timezone: "Asia/Shanghai", weekends: false, lunch: "12:00", dinner: "18:30", prepMinutes: 20, lingerMinutes: 45, notify: false },
      store: { storeCode: "1400123", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "常点一份", items: [{ productCode: "SAMPLE-001", quantity: 1 }] },
    }),
  );
  const env = {
    ...process.env,
    MCD_HOME: home,
    MCD_MCP_TOKEN: sampleToken,
    MCD_NOW: "2026-10-20T03:50:00Z",
  };
  const priced = await run(["hook", "--mock"], env, "{}\n");
  assert.equal(priced.code, 0, priced.stderr);
  assert.match(priced.stdout, /现在确认/);
  assert.equal(priced.stdout.includes(sampleToken), false);
  const gone = { ...env, MCD_MCP_TOKEN: "" };
  const line = await run(["statusline"], gone, "{}\n");
  assert.equal(line.code, 0, line.stderr);
  assert.match(line.stdout, /读不到 Token/);
  assert.match(line.stdout, /\btoken\b/);
  assert.equal(line.stdout.includes("现在确认"), false);
  assert.equal(line.stdout.includes(sampleToken), false);
  const hook = await run(["hook"], gone, "{}\n");
  assert.equal(hook.code, 0, hook.stderr);
  assert.match(hook.stdout, /读不到 Token/);
  assert.equal(hook.stdout.includes("现在确认"), false);
  assert.equal(hook.stdout.includes("confirm"), false);
  assert.equal(hook.stdout.includes(sampleToken), false);
});

test("idle statusline names the next meal without calling the network", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-idle-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      meals: { enabled: false, timezone: "Asia/Shanghai", weekends: false, lunch: "12:00", dinner: "18:30", prepMinutes: 20, lingerMinutes: 45, notify: false },
      store: { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1, takeWayCode: "eat-in" },
      usual: { label: "鸡薯双全盒", items: [{ productCode: "SAMPLE-001", quantity: 1 }] },
    }),
  );
  const env = { ...process.env, MCD_HOME: home, MCD_MCP_TOKEN: "", MCD_MCP_URL: "http://127.0.0.1:9", MCD_NOW: "2026-10-21T01:30:00.000Z" };
  const line = await run(["statusline"], env, "{}\n");
  assert.equal(line.code, 0, line.stderr);
  assert.equal(line.stdout, "mcd · 已就绪 · 午饭 12:00 · 常点 鸡薯双全盒\n");
  assert.equal(line.stdout.includes("待命"), false);
  const missing = await run(["statusline"], { ...env, MCD_HOME: mkdtempSync(join(tmpdir(), "mcd-cli-idle-empty-")) }, "{}\n");
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stdout, /还没选门店和常点/);
  assert.match(missing.stdout, /node /);
  assert.match(missing.stdout, /cli\.js init/);
});

test("help leads with the three steps, and bin hints differ from node hints", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-help-"));
  const isolated = {
    ...process.env,
    HOME: home,
    MCD_HOME: join(home, "mcd"),
    MCD_MCP_TOKEN: "",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const direct = await run(["--help"], isolated);
  assert.equal(direct.code, 0, direct.stderr);
  assertHelpShape(direct.stdout, /cli\.js token/, /cli\.js init && node /);
  assert.equal(direct.stdout.includes("\n  mcd-cooldown token\n"), false);
  assert.equal(direct.stdout.includes("\n  2. mcd-cooldown token\n"), false);

  const stage = mkdtempSync(join(tmpdir(), "mcd-cli-stage-"));
  cpSync(dirname(cli), join(stage, "dist/src"), { recursive: true });
  const stagedCli = join(stage, "dist/src/cli.js");
  chmodSync(stagedCli, 0o755);
  const bin = join(stage, "mcd-cooldown");
  symlinkSync(stagedCli, bin);
  const viaBin = spawnSync(bin, ["--help"], { encoding: "utf8", env: isolated });
  assert.equal(viaBin.status, 0, viaBin.stderr);
  assertHelpShape(viaBin.stdout, /mcd-cooldown token/, /mcd-cooldown init && mcd-cooldown setup claude/);
  assert.equal(viaBin.stdout.includes("cli.js"), false);

  const status = spawnSync(bin, ["statusline"], { encoding: "utf8", input: "{}\n", env: isolated });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /mcd-cooldown init/);
  assert.equal(status.stdout.includes("cli.js"), false);

  const init = spawnSync(bin, ["init"], { encoding: "utf8", env: isolated });
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /mcd-cooldown token/);
  assert.match(init.stderr, /mcd-cooldown init/);
  assert.equal(init.stderr.includes("cli.js"), false);
  const readyHome = mkdtempSync(join(tmpdir(), "mcd-cli-bin-init-"));
  const ready = spawnSync(
    bin,
    ["init", "--mock", "--meals", "--city", "示例市", "--keyword", "示例路", "--store", "SAMPLE-STORE", "--item", "SAMPLE-001", "--item", "2"],
    { encoding: "utf8", env: { ...isolated, HOME: readyHome, MCD_HOME: join(readyHome, "mcd") } },
  );
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /下一步：mcd-cooldown setup claude/);
  assert.match(ready.stdout, /mcd-cooldown meals weekends on/);
  assert.equal(ready.stdout.includes("cli.js"), false);

  const settings = join(home, "settings.json");
  const printed = spawnSync(bin, ["setup", "claude", "--print", "--settings", settings], { encoding: "utf8", env: isolated });
  assert.equal(printed.status, 0, printed.stderr);
  const body = JSON.parse(printed.stdout) as { statusLine: { command: string }; hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
  assert.match(body.statusLine.command, /^node /);
  assert.match(body.statusLine.command, /dist\/src\/cli\.js statusline$/);
  assert.match(body.hooks.Stop[0]?.hooks[0]?.command ?? "", /dist\/src\/cli\.js hook$/);
  assert.equal(body.statusLine.command.includes("mcd-cooldown statusline"), false);
  assert.equal(existsSync(settings), false);

  const decoy = mkdtempSync(join(tmpdir(), "mcd-cli-decoy-"));
  const decoyBin = join(decoy, "mcd-cooldown");
  writeFileSync(decoyBin, "#!/bin/sh\nexit 0\n");
  chmodSync(decoyBin, 0o755);
  const shadowed = await run(["--help"], { ...isolated, PATH: `${decoy}:/usr/bin:/bin` });
  assert.equal(shadowed.code, 0, shadowed.stderr);
  assert.match(shadowed.stdout, /cli\.js token/);
  assert.equal(shadowed.stdout.includes("\n  2. mcd-cooldown token\n"), false);

  const nodeInit = await run(["init"], isolated);
  assert.notEqual(nodeInit.code, 0);
  assert.match(nodeInit.stderr, /cli\.js token/);
  assert.match(nodeInit.stderr, /cli\.js init/);
  assert.equal(nodeInit.stderr.includes("mcd-cooldown init"), false);
});

function assertHelpShape(help: string, token: RegExp, setup: RegExp): void {
  const start = help.indexOf("三步开始");
  const other = help.indexOf("其他命令");
  const plan = help.indexOf("plan");
  assert.ok(start >= 0 && other > start && plan > other, help);
  assert.match(help, /npm install -g github:Adonis0123\/mcd-cooldown/);
  assert.match(help, token);
  assert.match(help, setup);
  assert.match(help, /0600/);
  assert.match(help, /非麦当劳官方产品/);
  assert.match(help, /默认只核价，不会自动下单/);
  assert.match(help, /init 只读查询门店和菜单，不会下单/);
  assert.ok(help.trim().split("\n").length < 30, String(help.trim().split("\n").length));
  const confirm = help.split("\n").find((line) => line.includes("confirm <请求号>"));
  const deny = help.split("\n").find((line) => line.includes("deny <请求号>"));
  assert.ok(confirm);
  assert.ok(deny);
  assert.equal(confirm?.includes("deny"), false);
  assert.notEqual(confirm, deny);
}
