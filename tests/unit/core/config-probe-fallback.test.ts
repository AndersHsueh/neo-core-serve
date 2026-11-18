/**
 * K03b-mpa：只解析 outputProbe 与 model_fallback。
 *
 * 非法 outputProbe 形状 fail-safe（回落默认关闭 / undefined），不抛错。
 * model_fallback 只接受对象数组，上限 8。未知键忽略，不得因此启用 MCP 或权限。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_OUTPUT_PROBE,
  MAX_MODEL_FALLBACKS,
  loadConfig,
  resolveModelFallback,
  resolveOutputProbe,
  type ProviderConfig,
} from "../../../src/core/config.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "k03b-"));
  created.push(dir);
  return dir;
}

function provider(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_name: name,
    provider_type: "openai",
    base_url: `http://127.0.0.1/${name}`,
    api_key: `key-${name}`,
    default_model_name: "m",
    deep_reasoning_model_name: "m",
    balanced_model_name: "m",
    fast_model_name: "m",
    ...extra,
  };
}

function loadFrom(settings: Record<string, unknown>, fileDir?: string) {
  const dir = fileDir ?? tmp();
  const home = tmp();
  const pkgRoot = tmp();
  process.env.HOME = home;
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
  return loadConfig({ cwd: dir }, { pkgRoot, homeDir: home, spawnDir: dir, env: { HOME: home } });
}

const providers: ProviderConfig[] = [
  {
    name: "primary",
    type: "openai",
    baseUrl: "http://127.0.0.1/p",
    apiKey: "k",
    models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
    maxTokens: 1024,
    temperature: 0.6,
    contextWindow: 8000,
  },
  {
    name: "backup",
    type: "openai",
    baseUrl: "http://127.0.0.1/b",
    apiKey: "k",
    models: { default: "b", deep_reasoning: "b", balanced: "b", fast: "b" },
    maxTokens: 1024,
    temperature: 0.6,
    contextWindow: 8000,
  },
];

describe("K03b outputProbe 解析", () => {
  test("未配置 → undefined（默认关闭，与今天行为一致）", () => {
    expect(resolveOutputProbe(undefined)).toBeUndefined();
  });

  test("true / false 简写", () => {
    expect(resolveOutputProbe(true)).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: true });
    expect(resolveOutputProbe(false)).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: false });
  });

  test("对象：缺 enabled 视为开启，其余字段覆盖默认", () => {
    expect(resolveOutputProbe({})).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: true });
    expect(resolveOutputProbe({ max_attempts: 5, start: 4_096, cap: 65_536 })).toEqual({
      enabled: true,
      maxAttempts: 5,
      start: 4_096,
      cap: 65_536,
    });
  });

  test("越界值夹紧：max_attempts 1–8、start ≥256、cap < start 时以 start 为准", () => {
    expect(resolveOutputProbe({ max_attempts: 0 })!.maxAttempts).toBe(1);
    expect(resolveOutputProbe({ max_attempts: 99 })!.maxAttempts).toBe(8);
    expect(resolveOutputProbe({ start: 100 })!.start).toBe(256);
    const s = resolveOutputProbe({ start: 32_768, cap: 8_192 })!;
    expect(s.start).toBe(32_768);
    expect(s.cap).toBe(32_768);
  });

  test("非法形状（字符串/数组/数字/null）→ undefined，不抛错", () => {
    expect(resolveOutputProbe("yes")).toBeUndefined();
    expect(resolveOutputProbe([1, 2])).toBeUndefined();
    expect(resolveOutputProbe(42)).toBeUndefined();
    expect(resolveOutputProbe(null)).toBeUndefined();
  });

  test("loadConfig 把 provider 与旧版顶层写法都解析到 provider.outputProbe", () => {
    const a = loadFrom({
      default_provider: "p",
      providers: [provider("p", { probe_max_output_tokens: true })],
    });
    expect(a.providers[0]?.outputProbe).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: true });

    const dir = tmp();
    const home = tmp();
    const pkgRoot = tmp();
    process.env.HOME = home;
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        "api-key": "legacy-key",
        OpenAI: "http://127.0.0.1/legacy",
        model_name: "legacy-m",
        probe_max_output_tokens: { max_attempts: 2, start: 4096, cap: 8192 },
      }),
      "utf8",
    );
    const legacy = loadConfig({ cwd: dir }, { pkgRoot, homeDir: home, spawnDir: dir, env: { HOME: home } });
    expect(legacy.legacyFormat).toBe(true);
    expect(legacy.providers[0]?.outputProbe).toEqual({
      enabled: true,
      maxAttempts: 2,
      start: 4096,
      cap: 8192,
    });
  });
});

describe("K03b model_fallback 解析", () => {
  test("缺省与空数组禁用；对象数组按出现顺序解析", () => {
    expect(resolveModelFallback(undefined, providers)).toEqual([]);
    expect(resolveModelFallback([], providers)).toEqual([]);
    expect(
      resolveModelFallback(
        [
          { provider: "backup", model: "b" },
          { provider: "primary", model: "m2" },
        ],
        providers,
      ),
    ).toEqual([
      { provider: "backup", model: "b" },
      { provider: "primary", model: "m2" },
    ]);
  });

  test("非法形状、未知 provider、空字段、重复项、超过 8 项都在解析期抛 ConfigError", () => {
    expect(() => resolveModelFallback("primary:m", providers)).toThrow(ConfigError);
    expect(() => resolveModelFallback({ provider: "backup", model: "b" }, providers)).toThrow(ConfigError);
    expect(() => resolveModelFallback([{ provider: "nope", model: "m" }], providers)).toThrow(ConfigError);
    expect(() => resolveModelFallback([{ provider: "primary", model: "" }], providers)).toThrow(ConfigError);
    expect(
      () =>
        resolveModelFallback(
          [
            { provider: "backup", model: "b" },
            { provider: "backup", model: "b" },
          ],
          providers,
        ),
    ).toThrow(ConfigError);
    const tooMany = Array.from({ length: MAX_MODEL_FALLBACKS + 1 }, (_, i) => ({
      provider: "backup",
      model: `m${i}`,
    }));
    expect(() => resolveModelFallback(tooMany, providers)).toThrow(ConfigError);
  });

  test("未实现协议与大小写敏感：provider 必须精确匹配", () => {
    const badList: ProviderConfig[] = [
      { ...providers[0]!, name: "claude", type: "anthropic" },
    ];
    expect(() => resolveModelFallback([{ provider: "claude", model: "m" }], badList)).toThrow(ConfigError);
    expect(() => resolveModelFallback([{ provider: "PRIMARY", model: "m" }], providers)).toThrow(ConfigError);
  });

  test("最多 8 项；恰好 8 项通过", () => {
    const eight = Array.from({ length: MAX_MODEL_FALLBACKS }, (_, i) => ({
      provider: "backup",
      model: `m${i}`,
    }));
    expect(resolveModelFallback(eight, providers)).toHaveLength(MAX_MODEL_FALLBACKS);
  });

  test("loadConfig 解析 settings.model_fallback", () => {
    const cfg = loadFrom({
      default_provider: "primary",
      providers: [provider("primary"), provider("backup")],
      model_fallback: [{ provider: "backup", model: "b" }],
    });
    expect(cfg.modelFallback).toEqual([{ provider: "backup", model: "b" }]);
  });
});

describe("K03b 未知键忽略，不得启用权限或 MCP", () => {
  test("hooks / permission_mode / parallel_tool_calls 不进入 Config；mcpServers 只进计量字段且不含启动命令", () => {
    const cfg = loadFrom({
      default_provider: "p",
      providers: [provider("p")],
      mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } },
      hooks: { SessionStart: [{ type: "command", command: "echo pwned" }] },
      permission_mode: "auto-all",
      parallel_tool_calls: "readonly",
      some_unknown_key: true,
    });
    const rec = cfg as unknown as Record<string, unknown>;
    // K09b：为对齐 4e3d7bb 的 prompt 计量，允许解析 name/alwaysLoad 子集。
    // command/args/url/transport 不得进入 Config，避免被当成可启动的 MCP 功能面。
    expect(cfg.mcpServers).toEqual([{ name: "fs" }]);
    expect(JSON.stringify(cfg.mcpServers)).not.toContain("npx");
    expect(JSON.stringify(cfg.mcpServers)).not.toContain("command");
    expect(cfg.mcp).toEqual({ toolSearch: "auto", toolSearchThreshold: 10 });
    expect(rec["hooks"]).toBeUndefined();
    expect(rec["permission_mode"]).toBeUndefined();
    expect(rec["parallel_tool_calls"]).toBeUndefined();
    expect(rec["some_unknown_key"]).toBeUndefined();
    expect(cfg.modelFallback).toEqual([]);
    expect(cfg.providers[0]?.outputProbe).toBeUndefined();
  });
});
