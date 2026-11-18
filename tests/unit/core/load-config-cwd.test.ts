/**
 * K03a：loadConfig 的 cwd / settingsDir / spawn 回落。
 *
 * 只测配置入口，不拉起 ACP / SessionHost。locator（pkgRoot/homeDir/spawnDir）
 * 可注入，避免向仓库根写入 settings.json。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/core/config.ts";

const created: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HOME",
  "NEO_PROVIDER",
  "NEO_TIER",
  "NEO_API_KEY",
  "NEO_BASE_URL",
  "NEO_MODEL",
  "NEO_CLASSIFIER_PROVIDER",
  "NEO_CLASSIFIER_MODEL",
];

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function isolateEnv(): void {
  for (const k of ENV_KEYS) {
    if (k in savedEnv) continue;
    savedEnv[k] = process.env[k];
    if (k !== "HOME") delete process.env[k];
  }
}

function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `k03a-${name}-`));
  created.push(dir);
  return dir;
}

function writeSettings(dir: string, provider: string, apiKey = `key-${provider}`): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        default_provider: provider,
        providers: [
          {
            provider_name: provider,
            provider_type: "openai",
            base_url: `http://127.0.0.1/${provider}`,
            api_key: apiKey,
            default_model_name: "m",
            deep_reasoning_model_name: "m",
            balanced_model_name: "m",
            fast_model_name: "m",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

describe("K03a-B 既有 cwd / HOME 回落（对照）", () => {
  test("loadConfig({cwd}) 读取工作区 settings，不串到 spawn/pkgRoot", () => {
    isolateEnv();
    const workspace = tmp("ws");
    const spawnDir = tmp("spawn");
    const pkgRoot = tmp("pkg");
    const home = tmp("home");
    process.env.HOME = home;
    writeSettings(workspace, "workspace");
    writeSettings(spawnDir, "spawnfile");
    writeSettings(pkgRoot, "pkgkeys");
    writeSettings(join(home, ".neo"), "homefile");

    const cfg = loadConfig({ cwd: workspace }, { spawnDir, pkgRoot, homeDir: home });
    expect(cfg.providerName).toBe("workspace");
    expect(cfg.cwd).toBe(workspace);
    expect(cfg.settingsPath).toBe(join(workspace, "settings.json"));
    expect(cfg.apiKey).toBe("key-workspace");
  });

  test("cwd 与 pkgRoot 都没有 settings 时回落到 ~/.neo", () => {
    isolateEnv();
    const workspace = tmp("ws-empty");
    const pkgRoot = tmp("pkg-empty");
    const home = tmp("home-only");
    process.env.HOME = home;
    writeSettings(join(home, ".neo"), "homefile");

    const cfg = loadConfig({ cwd: workspace }, { pkgRoot, homeDir: home, spawnDir: workspace });
    expect(cfg.providerName).toBe("homefile");
    expect(cfg.settingsPath).toBe(join(home, ".neo", "settings.json"));
  });
});

describe("K03a-N settingsDir / spawn 回落不得误用包装根密钥", () => {
  test("工作区与 spawn 都有 settings 时以工作区为准，不串 spawn", () => {
    isolateEnv();
    const workspace = tmp("ws2");
    const spawnDir = tmp("spawn2");
    const pkgRoot = tmp("pkg2");
    const home = tmp("home2");
    process.env.HOME = home;
    writeSettings(workspace, "workspace");
    writeSettings(spawnDir, "spawnfile");
    writeSettings(pkgRoot, "pkgkeys");

    const viaCwd = loadConfig({ cwd: workspace }, { spawnDir, pkgRoot, homeDir: home });
    const viaDir = loadConfig({}, { settingsDir: workspace, spawnDir, pkgRoot, homeDir: home });
    expect(viaCwd.providerName).toBe("workspace");
    expect(viaDir.providerName).toBe("workspace");
    expect(viaCwd.settingsPath).toBe(join(workspace, "settings.json"));
  });

  test("工作区缺 settings 时回落到启动目录，而不是包装根密钥", () => {
    isolateEnv();
    const workspace = tmp("ws-miss");
    const spawnDir = tmp("spawn-hit");
    const pkgRoot = tmp("pkg-keys");
    const home = tmp("home-miss");
    process.env.HOME = home;
    writeSettings(spawnDir, "spawnfile");
    writeSettings(pkgRoot, "pkgkeys");
    writeSettings(join(home, ".neo"), "homefile");

    const viaCwd = loadConfig({ cwd: workspace }, { spawnDir, pkgRoot, homeDir: home });
    const viaDir = loadConfig({}, { settingsDir: workspace, spawnDir, pkgRoot, homeDir: home });
    expect(viaCwd.providerName).toBe("spawnfile");
    expect(viaDir.providerName).toBe("spawnfile");
    expect(viaCwd.settingsPath).toBe(join(spawnDir, "settings.json"));
    expect(viaDir.settingsPath).toBe(join(spawnDir, "settings.json"));
    expect(viaCwd.apiKey).toBe("key-spawnfile");
    expect(viaCwd.apiKey).not.toBe("key-pkgkeys");
  });
});
