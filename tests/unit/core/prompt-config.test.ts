/**
 * K08：settings.system_prompt 接到 loadConfig，并与 selectPromptTier 一起用。
 *
 * 对照 neo-cli 4e3d7bb 的 resolveSystemPromptConfig 行为（非法值回落默认、比例夹取）。
 * 这不是 MCP 功能面，也不扩 compat 导出。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resolveSystemPromptConfig } from "../../../src/core/config.ts";
import { DEFAULT_SELECTION_CONFIG, selectPromptTier } from "../../../src/core/prompt/select.ts";
import { countSystemTokens } from "../../../src/core/prompt/tokens.ts";
import { TIER_CORE, type PromptTier } from "../../../src/core/prompt/tiers.ts";
import { renderCore } from "../../../src/core/prompt/render.ts";
import { buildSystemPrompt } from "../../../src/core/system-prompt.ts";

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
  const dir = mkdtempSync(join(tmpdir(), `k08-${name}-`));
  created.push(dir);
  return dir;
}

function writeSettings(dir: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        default_provider: "p",
        providers: [
          {
            provider_name: "p",
            provider_type: "openai",
            base_url: "http://127.0.0.1/p",
            api_key: "key-p",
            default_model_name: "m",
            deep_reasoning_model_name: "m",
            balanced_model_name: "m",
            fast_model_name: "m",
          },
        ],
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
  return path;
}

describe("settings.system_prompt 解析", () => {
  test("缺省/非法值回落默认；合法值生效并夹取", () => {
    expect(resolveSystemPromptConfig(undefined)).toEqual(DEFAULT_SELECTION_CONFIG);
    expect(resolveSystemPromptConfig(null)).toEqual(DEFAULT_SELECTION_CONFIG);
    expect(resolveSystemPromptConfig("full")).toEqual(DEFAULT_SELECTION_CONFIG);
    expect(resolveSystemPromptConfig([])).toEqual(DEFAULT_SELECTION_CONFIG);
    expect(resolveSystemPromptConfig({ selection_mode: "nope", max_tier: "xl", unknown_window_budget: -1 })).toEqual(
      DEFAULT_SELECTION_CONFIG,
    );

    const ok = resolveSystemPromptConfig({
      selection_mode: "context-gated",
      system_budget_ratio: 0.5,
      max_tier: "standard",
      unknown_window_budget: 4096.9,
      trust_known_window: true,
      ignored: 1,
    });
    expect(ok.selectionMode).toBe("context-gated");
    expect(ok.systemBudgetRatio).toBe(0.3);
    expect(ok.maxTier).toBe("standard");
    expect(ok.unknownWindowBudget).toBe(4096);
    expect(ok.trustKnownWindow).toBe(true);
  });

  test("loadConfig 读到 system_prompt，缺省等于 DEFAULT_SELECTION_CONFIG", () => {
    isolateEnv();
    const workspace = tmp("ws");
    const home = tmp("home");
    process.env.HOME = home;
    writeSettings(workspace);
    const cfg = loadConfig({ cwd: workspace }, { spawnDir: workspace, pkgRoot: tmp("pkg"), homeDir: home });
    expect(cfg.systemPrompt).toEqual(DEFAULT_SELECTION_CONFIG);

    writeSettings(workspace, {
      system_prompt: { selection_mode: "context-gated", max_tier: "mini", trust_known_window: true },
    });
    const cfg2 = loadConfig({ cwd: workspace }, { spawnDir: workspace, pkgRoot: tmp("pkg2"), homeDir: home });
    expect(cfg2.systemPrompt?.selectionMode).toBe("context-gated");
    expect(cfg2.systemPrompt?.maxTier).toBe("mini");
    expect(cfg2.systemPrompt?.trustKnownWindow).toBe(true);
  });
});

describe("接到 C 组 prompt 路径：用档位核心 + 现有动态块计开销再选档", () => {
  test("source=default 的配置窗口即使很大也选 mini", () => {
    isolateEnv();
    const workspace = tmp("dyn");
    const home = tmp("home");
    process.env.HOME = home;
    writeSettings(workspace);
    const cfg = loadConfig({ cwd: workspace }, { spawnDir: workspace, pkgRoot: tmp("pkg"), homeDir: home });
    cfg.contextWindow = 200_000;
    cfg.contextWindowSource = "default";
    cfg.env = { ...(cfg.env ?? {}), prompt: false };

    const dynamic = buildSystemPrompt(cfg, { mailbox: false, askUser: true });
    const overhead: Partial<Record<PromptTier, number>> = {};
    for (const t of ["full", "standard", "mini"] as const) {
      overhead[t] = countSystemTokens([`${renderCore(t, "neo")}\n\n${dynamic}`], []).tokens;
    }
    const sel = selectPromptTier({
      window: cfg.contextWindow,
      source: cfg.contextWindowSource,
      overhead,
      config: cfg.systemPrompt,
    });
    expect(sel.tier).toBe("mini");
    expect(sel.windowTrusted).toBe(false);
    expect(sel.budget).toBe(Math.floor(DEFAULT_SELECTION_CONFIG.unknownWindowBudget * 0.125));
    expect(TIER_CORE.mini.length).toBeGreaterThan(0);
    expect(dynamic).toContain("## 工具");
  });
});
