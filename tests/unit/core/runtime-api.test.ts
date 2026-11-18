/**
 * K45a：运行时公共面（本波实际需要 + 诚实占位）。
 *
 * 不是半真半假的会话门面，也不扩 compat/v1 归档。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathDeniedError } from "../../../src/core/path.ts";

const created: string[] = [];
const savedHome = process.env.HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "k45a-"));
  created.push(dir);
  return dir;
}

function writeSettings(dir: string, provider: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      default_provider: provider,
      providers: [
        {
          provider_name: provider,
          provider_type: "openai",
          base_url: `http://127.0.0.1/${provider}`,
          api_key: `secret-${provider}`,
          default_model_name: "m",
          deep_reasoning_model_name: "m",
          balanced_model_name: "m",
          fast_model_name: "m",
        },
      ],
    }),
    "utf8",
  );
}

test("K45a runtime 模块提供 version、端口类型、loadRuntimeConfig 与占位 owner", async () => {
  const rt = await import("../../../src/core/runtime/index.ts");
  expect(typeof rt.runtimeApiVersion).toBe("string");
  expect(rt.runtimeApiVersion.length).toBeGreaterThan(0);
  expect(rt.NO_RUNTIME_RESOURCE_OWNER).toEqual({ kind: "none", note: "本批不登记新进程" });
  expect(rt.NO_RUNTIME_STORE).toEqual({ kind: "placeholder", note: "本批不登记新进程" });
  expect(rt.NOOP_LIFECYCLE_PORT).toBeDefined();
  expect("createRuntimeSession" in rt).toBe(false);
  expect(typeof (rt as { createRuntimeSession?: unknown }).createRuntimeSession).toBe("undefined");
  expect(typeof (rt as { send?: unknown }).send).toBe("undefined");
});

test("K45a loadRuntimeConfig 不 chdir，并用 locator 读工作区配置", async () => {
  const { loadRuntimeConfig, runtimeConfigPublicView } = await import("../../../src/core/runtime/index.ts");
  const workspace = tmp();
  const spawnDir = tmp();
  const pkgRoot = tmp();
  const home = tmp();
  process.env.HOME = home;
  writeSettings(workspace, "workspace");
  writeSettings(pkgRoot, "pkgkeys");
  const before = process.cwd();
  const cfg = loadRuntimeConfig({
    cwd: workspace,
    env: { HOME: home },
    locator: { spawnDir, pkgRoot, homeDir: home },
  });
  expect(process.cwd()).toBe(before);
  expect(cfg.providerName).toBe("workspace");
  expect(cfg.cwd).toBe(workspace);
  expect(cfg.apiKey).toBe("secret-workspace"); // trusted host 仍可读
  const view = runtimeConfigPublicView(cfg);
  expect(JSON.stringify(view)).not.toContain("secret-workspace");
  expect(view.providerName).toBe("workspace");
  expect(view.apiKeyMask).toBeDefined();
});

test("K45a 默认 strict-core PathPolicy；legacy-fusion 不得经默认工厂放宽", async () => {
  const { createRuntimePathPolicy } = await import("../../../src/core/runtime/index.ts");
  const cwd = tmp();
  writeFileSync(join(cwd, "inside.txt"), "ok", "utf8");
  const policy = createRuntimePathPolicy(cwd);
  expect(policy.resolveRead(join(cwd, "inside.txt"))).toContain("inside.txt");
  const outside = join(tmp(), "outside.txt");
  writeFileSync(outside, "no", "utf8");
  expect(() => policy.resolveRead(outside)).toThrow(PathDeniedError);
  expect(() => createRuntimePathPolicy(cwd, "legacy-fusion")).toThrow(/strict-core|不得经此放宽|TUI/);
});

test("K45a 不把 runtime 打进 compat/v1 导出面", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(import.meta.dir, "../../..");
  const dts = readFileSync(join(root, "src/compat/v1.d.ts"), "utf8");
  expect(dts).not.toContain("loadRuntimeConfig");
  expect(dts).not.toContain("createRuntimeSession");
  expect(dts).not.toContain("LifecyclePort");
  const pack = readFileSync(join(root, "tests/unit/compat-pack.test.ts"), "utf8");
  expect(pack).toContain('"./compat/v1"');
  expect(pack).not.toContain("core/runtime");
});
