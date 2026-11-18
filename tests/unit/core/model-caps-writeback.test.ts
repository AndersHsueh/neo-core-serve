/**
 * K05b：空字段写回 settings.json。只写测试配置，手写值优先，只允许能力字段。
 * 不迁 /context UI。agent 循环级 length 回调有独立窄测；不在循环里 import 写回模块。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  isCapabilityUndeclared,
  probeCapabilitiesOnFirstUse,
  resetFirstUseProbeMemo,
  undeclaredCapabilityFields,
  writeBackCapabilities,
  writeBackContextLimit,
  writeBackOutputLimit,
} from "../../../src/core/env/modelCaps.ts";
import { machineKeyOf, snapshotFile, writeSnapshot } from "../../../src/core/env/probe.ts";
import type { EnvStatic } from "../../../src/core/env/types.ts";
import { loadConfig, maskKey, type Config, type ProviderConfig } from "../../../src/core/config.ts";
import { buildSettingsView } from "../../../src/core/session-host.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-modelcaps-p3-"));
const OLD_ENV_HOME = process.env["NEO_ENV_HOME"];

beforeAll(() => {
  process.env["NEO_ENV_HOME"] = SANDBOX;
});

afterAll(() => {
  if (OLD_ENV_HOME === undefined) delete process.env["NEO_ENV_HOME"];
  else process.env["NEO_ENV_HOME"] = OLD_ENV_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

afterEach(() => {
  resetFirstUseProbeMemo();
});

let seq = 0;

function writeSettings(providers: Record<string, unknown>[]): string {
  seq += 1;
  const dir = join(SANDBOX, `case-${seq}`);
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ default_provider: "p1", providers }, null, 2)}\n`, "utf8");
  return path;
}

function readSettings(path: string): { providers: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, unknown>[] };
}

function providerEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_name: "p1",
    provider_type: "openai",
    base_url: "http://127.0.0.1:1/v1",
    api_key: "k",
    default_model_name: "m1",
    ...over,
  };
}

function provFrom(entry: Record<string, unknown>, name = "p1"): ProviderConfig {
  return {
    name,
    type: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    models: { default: "m1", deep_reasoning: "m1", balanced: "m1", fast: "m1" },
    maxTokens: (entry["max_tokens"] as number | undefined) ?? null,
    temperature: null,
    contextWindow: (entry["context_window"] as number | undefined) ?? null,
    vision: entry["vision"] as boolean | undefined,
    tools: entry["tools"] as boolean | undefined,
    reasoning: entry["reasoning"] as boolean | undefined,
    maxOutputTokens: (entry["max_output_tokens"] as number | undefined) ?? null,
  };
}

function makeCfg(over: Partial<Config> & { providers?: ProviderConfig[] } = {}): Config {
  const providers = over.providers ?? [provFrom(providerEntry())];
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "m1",
    modelTier: "default",
    contextWindow: 100_000,
    contextWindowSource: "config",
    maxTokens: 8_192,
    temperature: 0.6,
    compactThreshold: 0.75,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    providers,
    env: {},
    cwd: SANDBOX,
    settingsPath: null,
    ...over,
  } as unknown as Config;
}

function writeBaseSnapshot(cfg: Config): void {
  const key = machineKeyOf(hostname(), platform(), arch());
  const file = snapshotFile(SANDBOX, key, cfg.env);
  writeSnapshot(file, {
    version: 1,
    collectedAt: new Date().toISOString(),
    machineKey: key,
    shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
  } as unknown as EnvStatic);
}

function serveModels(entry: Record<string, unknown>): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [entry] });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { port: Number(server.port), stop: () => server.stop(true) };
}

describe("写回：手写值绝对优先", () => {
  test("已填 vision:false 不会被探测的 true 改掉", () => {
    const settingsPath = writeSettings([providerEntry({ vision: false, max_tokens: 8192 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ vision: false, max_tokens: 8192 }))],
    });
    const r = writeBackCapabilities(cfg, { vision: true, tools: true, reasoning: true });
    expect(r.skipped).toContain("vision");
    expect(r.written).toEqual(["tools", "reasoning"]);
    const onDisk = readSettings(settingsPath).providers[0]!;
    expect(onDisk["vision"]).toBe(false);
    expect(onDisk["tools"]).toBe(true);
    expect(onDisk["reasoning"]).toBe(true);
    expect(onDisk["max_tokens"]).toBe(8192);
    expect(onDisk["api_key"]).toBe("k");
  });

  test("已填数字（>0）不被覆盖；0 视作未填", () => {
    const settingsPath = writeSettings([providerEntry({ context_window: 128000, max_output_tokens: 0 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ context_window: 128000, max_output_tokens: 0 }))],
    });
    const r = writeBackCapabilities(cfg, { contextWindow: 64_000, maxOutputTokens: 4096 });
    expect(r.skipped).toContain("context_window");
    expect(r.written).toContain("max_output_tokens");
    const onDisk = readSettings(settingsPath).providers[0]!;
    expect(onDisk["context_window"]).toBe(128000);
    expect(onDisk["max_output_tokens"]).toBe(4096);
  });

  test("探测值 unknown 不写", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    const r = writeBackCapabilities(cfg, { vision: "unknown", tools: "unknown", reasoning: "unknown" });
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["vision"]).toBeUndefined();
  });

  test("settingsPath 为空 → no-op，但仍同步内存", () => {
    const cfg = makeCfg({ settingsPath: null, providers: [provFrom(providerEntry())] });
    const r = writeBackCapabilities(cfg, { vision: true, maxOutputTokens: 4096 });
    expect(r.persisted).toBe(false);
    expect(cfg.providers[0]?.vision).toBe(true);
    expect(cfg.providers[0]?.maxOutputTokens).toBe(4096);
  });
});

describe("写回：空字段落盘且读回一致", () => {
  test("max_output_tokens 写入，max_tokens 保持原值", () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 8192 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ max_tokens: 8192 }))],
    });
    const r = writeBackCapabilities(cfg, { maxOutputTokens: 32_768 });
    expect(r.written).toEqual(["max_output_tokens"]);
    expect(r.persisted).toBe(true);
    const onDisk = readSettings(settingsPath).providers[0]!;
    expect(onDisk["max_output_tokens"]).toBe(32_768);
    expect(onDisk["max_tokens"]).toBe(8192);
    expect(onDisk["api_key"]).toBe("k");
    expect(onDisk["base_url"]).toBe("http://127.0.0.1:1/v1");
  });

  test("只改当前 provider 那一项，其它 provider 原样", () => {
    const other = { ...providerEntry({ provider_name: "p2", default_model_name: "m2" }), vision: true };
    const settingsPath = writeSettings([providerEntry(), other]);
    const cfg = makeCfg({
      settingsPath,
      providerName: "p1",
      providers: [provFrom(providerEntry()), provFrom(other, "p2")],
    });
    writeBackCapabilities(cfg, { vision: false });
    const list = readSettings(settingsPath).providers;
    expect(list[0]!["vision"]).toBe(false);
    expect(list[1]!["vision"]).toBe(true);
    expect(list[1]!["provider_name"]).toBe("p2");
  });

  test("settings.json 不可解析 → 不写盘、不崩，内存仍同步", () => {
    const settingsPath = writeSettings([providerEntry()]);
    writeFileSync(settingsPath, "{not-json", "utf8");
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    const r = writeBackCapabilities(cfg, { tools: true });
    expect(r.persisted).toBe(false);
    expect(cfg.providers[0]?.tools).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe("{not-json");
  });
});

describe("撞墙写回", () => {
  test("上下文溢出：空的 context_window 被补上", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    const r = writeBackContextLimit(cfg, 128_000);
    expect(r.written).toEqual(["context_window"]);
    expect(readSettings(settingsPath).providers[0]!["context_window"]).toBe(128_000);
  });

  test("上下文溢出：已填的 context_window 不被覆盖", () => {
    const settingsPath = writeSettings([providerEntry({ context_window: 200_000 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ context_window: 200_000 }))],
    });
    const r = writeBackContextLimit(cfg, 128_000);
    expect(r.written).toEqual([]);
    expect(r.skipped).toContain("context_window");
    expect(readSettings(settingsPath).providers[0]!["context_window"]).toBe(200_000);
  });

  test("输出撞墙：/models 拿到上限 → 补 max_output_tokens", async () => {
    const s = serveModels({ id: "m1", max_output_tokens: 16_384 });
    try {
      const settingsPath = writeSettings([providerEntry({ max_tokens: 8192 })]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry({ max_tokens: 8192 }))],
      });
      const r = await writeBackOutputLimit(cfg);
      expect(r.written).toEqual(["max_output_tokens"]);
      const onDisk = readSettings(settingsPath).providers[0]!;
      expect(onDisk["max_output_tokens"]).toBe(16_384);
      expect(onDisk["max_tokens"]).toBe(8192);
    } finally {
      s.stop();
    }
  });

  test("输出撞墙：探测不到 → 什么都不写", async () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 64 })]);
    const cfg = makeCfg({
      settingsPath,
      baseUrl: "http://127.0.0.1:1/v1",
      providers: [provFrom(providerEntry({ max_tokens: 64 }))],
    });
    const r = await writeBackOutputLimit(cfg);
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBeUndefined();
    expect(readSettings(settingsPath).providers[0]!["max_tokens"]).toBe(64);
  });

  test("已手写 max_output_tokens 不被 /models 覆盖，max_tokens 不动", async () => {
    const s = serveModels({ id: "m1", max_output_tokens: 4096 });
    try {
      const settingsPath = writeSettings([providerEntry({ max_tokens: 8192, max_output_tokens: 65_536 })]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry({ max_tokens: 8192, max_output_tokens: 65_536 }))],
      });
      const r = await writeBackOutputLimit(cfg);
      expect(r.written).toEqual([]);
      expect(r.skipped).toContain("max_output_tokens");
      const onDisk = readSettings(settingsPath).providers[0]!;
      expect(onDisk["max_output_tokens"]).toBe(65_536);
      expect(onDisk["max_tokens"]).toBe(8192);
    } finally {
      s.stop();
    }
  });
});

describe("首次使用探测", () => {
  test("五项全未填 → 触发；写回后 settings 出现新字段", async () => {
    const s = serveModels({
      id: "m1",
      context_length: 131_072,
      max_output_tokens: 16_384,
      vision: true,
      tools: true,
      reasoning: false,
    });
    try {
      const settingsPath = writeSettings([providerEntry()]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry())],
      });
      writeBaseSnapshot(cfg);
      expect(isCapabilityUndeclared(cfg)).toBe(true);
      const r = await probeCapabilitiesOnFirstUse(cfg);
      expect(r.ran).toBe(true);
      expect(r.written).toEqual(["context_window", "max_output_tokens", "vision", "tools", "reasoning"]);
      const onDisk = readSettings(settingsPath).providers[0]!;
      expect(onDisk["context_window"]).toBe(131_072);
      expect(onDisk["max_output_tokens"]).toBe(16_384);
      expect(onDisk["vision"]).toBe(true);
      expect(onDisk["tools"]).toBe(true);
      expect(onDisk["reasoning"]).toBe(false);
    } finally {
      s.stop();
    }
  });

  test("本进程只跑一次", async () => {
    const s = serveModels({ id: "m1", context_length: 1000, vision: true, tools: true, reasoning: true, max_output_tokens: 1024 });
    try {
      const settingsPath = writeSettings([providerEntry()]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry())],
      });
      writeBaseSnapshot(cfg);
      const first = await probeCapabilitiesOnFirstUse(cfg);
      expect(first.ran).toBe(true);
      const second = await probeCapabilitiesOnFirstUse(cfg);
      expect(second.ran).toBe(false);
    } finally {
      s.stop();
    }
  });

  test("只填了 context_window → 仍探测，只补空字段，不覆盖手写窗口和 false", async () => {
    const s = serveModels({
      id: "m1",
      context_length: 64_000,
      max_output_tokens: 2048,
      vision: true,
      tools: true,
      reasoning: true,
    });
    try {
      const settingsPath = writeSettings([providerEntry({ context_window: 200_000, vision: false })]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry({ context_window: 200_000, vision: false }))],
      });
      writeBaseSnapshot(cfg);
      expect(undeclaredCapabilityFields(cfg)).toEqual(["max_output_tokens", "tools", "reasoning"]);
      const r = await probeCapabilitiesOnFirstUse(cfg);
      expect(r.ran).toBe(true);
      const onDisk = readSettings(settingsPath).providers[0]!;
      expect(onDisk["context_window"]).toBe(200_000);
      expect(onDisk["vision"]).toBe(false);
      expect(onDisk["max_output_tokens"]).toBe(2048);
      expect(onDisk["tools"]).toBe(true);
    } finally {
      s.stop();
    }
  });

  test("五项都已填（含 false）→ 不触发首次探测", async () => {
    const cfg = makeCfg({
      providers: [
        provFrom(
          providerEntry({
            context_window: 1000,
            max_output_tokens: 1000,
            vision: false,
            tools: false,
            reasoning: false,
          }),
        ),
      ],
    });
    expect(isCapabilityUndeclared(cfg)).toBe(false);
    expect(undeclaredCapabilityFields(cfg)).toEqual([]);
    const r = await probeCapabilitiesOnFirstUse(cfg);
    expect(r.ran).toBe(false);
  });

  test("探测不可达 → 静默返回，不写坏 settings", async () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 8192 })]);
    const raw = readFileSync(settingsPath, "utf8");
    const cfg = makeCfg({
      settingsPath,
      baseUrl: "http://127.0.0.1:1/v1",
      providers: [provFrom(providerEntry({ max_tokens: 8192 }))],
    });
    const r = await probeCapabilitiesOnFirstUse(cfg);
    expect(r.ran).toBe(true);
    expect(r.written).toEqual([]);
    expect(readFileSync(settingsPath, "utf8")).toBe(raw);
  });
});

describe("settings.get 掩码不退化", () => {
  test("写回后 buildSettingsView 仍只给 apiKeyMask，不含原始 key", () => {
    const settingsPath = writeSettings([providerEntry({ api_key: "sk-secret-value", max_tokens: 8192 })]);
    const providers = [provFrom(providerEntry({ api_key: "sk-secret-value", max_tokens: 8192 }))];
    providers[0]!.apiKey = "sk-secret-value";
    const cfg = makeCfg({ settingsPath, apiKey: "sk-secret-value", providers });
    writeBackCapabilities(cfg, { vision: true, maxOutputTokens: 4096 });
    expect(readSettings(settingsPath).providers[0]!["api_key"]).toBe("sk-secret-value");

    const dir = settingsPath.slice(0, settingsPath.lastIndexOf("/"));
    const isolated = join(SANDBOX, "empty-home");
    mkdirSync(isolated, { recursive: true });
    const saved: Record<string, string | undefined> = {};
    for (const k of ["NEO_API_KEY", "NEO_PROVIDER", "NEO_BASE_URL", "NEO_MODEL"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const loaded = loadConfig({}, {
        settingsDir: dir,
        spawnDir: dir,
        pkgRoot: isolated,
        homeDir: isolated,
      });
      const view = buildSettingsView(loaded);
      const dumped = JSON.stringify(view);
      expect(dumped).not.toContain("sk-secret-value");
      expect(view.providers[0]?.apiKeyMask).toBe(maskKey("sk-secret-value"));
      expect((view.providers[0] as { apiKey?: string }).apiKey).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
