/**
 * K05a：输出上限探测的纯判定与有界阶梯。默认不探；假 request，不连真实模型。
 * 写回 settings 放在 K05b。C1 解析已由 K03b 覆盖，这里不重复 loadConfig 集成。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_OUTPUT_PROBE, type Config } from "../../../src/core/config.ts";
import {
  OUTPUT_PROBE_MEMO_TTL_DAYS,
  applyProbeOutcome,
  classifyProbeError,
  persistLearnedOutputLimit,
  probeCandidates,
  readOutputProbeMemo,
  recordOutputLimitFact,
  runOutputProbe,
  shouldRunOutputProbe,
  type OutputProbeSettings,
  type ProbeOutcome,
} from "../../../src/core/env/outputProbe.ts";
import {
  chat,
  resetLearnedMaxTokens,
  resetMaxTokensLimitLearnedHandler,
  setMaxTokensLimitLearnedHandler,
} from "../../../src/core/llm.ts";
import { recordModelContext } from "../../../src/core/env/modelWindows.ts";
import { machineKeyOf, snapshotFile, writeSnapshot } from "../../../src/core/env/probe.ts";
import type { EnvStatic } from "../../../src/core/env/types.ts";
import { LLMError } from "../../../src/core/llm.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-output-probe-"));
const OLD_ENV_HOME = process.env["NEO_ENV_HOME"];

beforeAll(() => {
  process.env["NEO_ENV_HOME"] = SANDBOX;
});

afterAll(() => {
  if (OLD_ENV_HOME === undefined) delete process.env["NEO_ENV_HOME"];
  else process.env["NEO_ENV_HOME"] = OLD_ENV_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "m1",
    modelTier: "default",
    contextWindow: 100_000,
    maxTokens: 8_192,
    providers: [],
    env: {},
    cwd: SANDBOX,
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

function settings(): OutputProbeSettings {
  return { ...DEFAULT_OUTPUT_PROBE, enabled: true };
}

function scripted(plan: Array<unknown | Error>): {
  request: (candidate: number) => Promise<unknown>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    request: async (candidate: number) => {
      calls.push(candidate);
      const next = plan.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("B1 阶梯：从 start 翻倍，受 cap 与 max_attempts 双重限制", () => {
  test("默认 3 档：8192 / 16384 / 32768", () => {
    expect(probeCandidates({ ...DEFAULT_OUTPUT_PROBE, enabled: true })).toEqual([8192, 16384, 32768]);
  });

  test("max_attempts=1 只试 start", () => {
    expect(probeCandidates({ enabled: true, maxAttempts: 1, start: 8192, cap: 131_072 })).toEqual([8192]);
  });

  test("cap 截断：start=8192 cap=20000 → 8192 / 16384", () => {
    expect(probeCandidates({ enabled: true, maxAttempts: 8, start: 8192, cap: 20_000 })).toEqual([8192, 16384]);
  });

  test("start === cap 时只有一档", () => {
    expect(probeCandidates({ enabled: true, maxAttempts: 3, start: 8192, cap: 8192 })).toEqual([8192]);
  });
});

describe("B2 探测判定：只认可解析的精确上限，其余不猜", () => {
  test("阶梯顶全部成功 → lower_bound（不写配置的由调用方决定）", async () => {
    const { request, calls } = scripted([{}, {}, {}]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r).toMatchObject({ outcome: "lower_bound", atLeast: 32768 });
    expect(calls).toEqual([8192, 16384, 32768]);
  });

  test("中途 400 明说上限 → found，且立即停止", async () => {
    const { request, calls } = scripted([
      {},
      {},
      new LLMError("max tokens > 24576", 400, "max tokens > 24576"),
    ]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r.outcome).toBe("found");
    if (r.outcome === "found") expect(r.limit).toBe(24576);
    expect(calls).toEqual([8192, 16384, 32768]);
  });

  test("第一档就明说上限 → found，只发一次请求", async () => {
    const { request, calls } = scripted([new LLMError("max tokens > 4096", 400)]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r).toMatchObject({ outcome: "found", limit: 4096 });
    expect(calls).toEqual([8192]);
  });

  test("不透明 400 → inconclusive(opaque)，不归因、不继续试", async () => {
    const { request, calls } = scripted([
      new LLMError("request was rejected by an internal MaaS component", 400),
    ]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r).toMatchObject({ outcome: "inconclusive", reason: "opaque" });
    expect(calls).toEqual([8192]);
  });

  test("上下文超长 / 鉴权 / 5xx 各自中止并给出原因", async () => {
    for (const [err, reason] of [
      [new LLMError("prompt is too long: 250000 tokens > 200000 maximum", 400), "context"],
      [new LLMError("invalid api key", 401), "auth"],
      [new LLMError("boom", 500), "other"],
    ] as const) {
      const { request, calls } = scripted([err]);
      const r = await runOutputProbe({ settings: settings(), request });
      expect(r).toMatchObject({ outcome: "inconclusive", reason });
      expect(calls).toEqual([8192]);
    }
  });

  test("max_attempts 严格生效：请求次数不超过配置", async () => {
    const { request, calls } = scripted([{}, {}, {}, {}, {}]);
    const r = await runOutputProbe({
      settings: { enabled: true, maxAttempts: 2, start: 8192, cap: 131_072 },
      request,
    });
    expect(r).toMatchObject({ outcome: "lower_bound", atLeast: 16384 });
    expect(calls).toEqual([8192, 16384]);
  });

  test("鉴权失败不得分类成 limit", () => {
    expect(classifyProbeError(new LLMError("invalid api key", 400), 8192).kind).toBe("auth");
    expect(classifyProbeError(new LLMError("unauthorized", 401), 8192).kind).toBe("auth");
  });
});

describe("C2 是否该探：关闭 / 已声明 / 近期探过 / 该探", () => {
  test("开关关闭 → disabled（默认配置即关闭）", () => {
    expect(shouldRunOutputProbe({ settings: DEFAULT_OUTPUT_PROBE, outputLimitDeclared: false })).toEqual({
      run: false,
      reason: "disabled",
    });
  });

  test("已手写上限 → declared", () => {
    expect(shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: true })).toEqual({
      run: false,
      reason: "declared",
    });
  });

  test("7 天内探过 → recent", () => {
    const memo = { at: "2026-11-08T00:00:00Z", outcome: "inconclusive" as const };
    const at = new Date("2026-11-10T00:00:00Z");
    expect(shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: false, memo, now: at })).toEqual({
      run: false,
      reason: "recent",
    });
  });

  test("超过 7 天 → 再探", () => {
    const memo = { at: "2026-10-01T00:00:00Z", outcome: "inconclusive" as const };
    const at = new Date("2026-11-10T00:00:00Z");
    expect(shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: false, memo, now: at })).toEqual({
      run: true,
      reason: "ok",
    });
  });

  test("没有任何 memo → 该探", () => {
    expect(shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: false })).toEqual({
      run: true,
      reason: "ok",
    });
  });

  test("TTL 常量是 7 天（口径写死在测试里，改常量要先改这里）", () => {
    expect(OUTPUT_PROBE_MEMO_TTL_DAYS).toBe(7);
  });
});

describe("K05a 缓存隔离：provider / model / cwd（env.dir）", () => {
  test("memo 按 provider|model 隔离，不同 env.dir 不共享快照", () => {
    const dirA = join(SANDBOX, "iso-a");
    const dirB = join(SANDBOX, "iso-b");
    const a = makeCfg({ providerName: "p1", model: "m1", env: { dir: dirA } });
    const aOtherModel = makeCfg({ providerName: "p1", model: "m2", env: { dir: dirA } });
    const aOtherProv = makeCfg({ providerName: "p2", model: "m1", env: { dir: dirA } });
    const b = makeCfg({ providerName: "p1", model: "m1", env: { dir: dirB } });
    writeBaseSnapshot(a);
    writeBaseSnapshot(b);
    recordOutputLimitFact(a, {
      source: "config",
      value: 4096,
      evidence: "iso",
      memo: { at: "2026-11-19T00:00:00Z", outcome: "found", limit: 4096 },
    });
    expect(readOutputProbeMemo(a)?.limit).toBe(4096);
    expect(readOutputProbeMemo(aOtherModel)).toBeUndefined();
    expect(readOutputProbeMemo(aOtherProv)).toBeUndefined();
    expect(readOutputProbeMemo(b)).toBeUndefined();
    // 同 key 但不同 env.dir：B 写入不影响 A
    recordModelContext(b, {
      contextWindow: null,
      source: "config",
      outputProbe: { at: "2026-11-19T00:00:00Z", outcome: "inconclusive", reason: "opaque" },
    });
    expect(readOutputProbeMemo(a)?.outcome).toBe("found");
    expect(readOutputProbeMemo(b)?.outcome).toBe("inconclusive");
  });
});


function writeSettings(providers: Record<string, unknown>[]): string {
  const dir = join(SANDBOX, `wb-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

function provFrom(entry: Record<string, unknown>) {
  return {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    models: { default: "m1", deep_reasoning: "m1", balanced: "m1", fast: "m1" },
    maxTokens: (entry["max_tokens"] as number | undefined) ?? null,
    temperature: null,
    contextWindow: (entry["context_window"] as number | undefined) ?? null,
    maxOutputTokens: (entry["max_output_tokens"] as number | undefined) ?? null,
    vision: entry["vision"] as boolean | undefined,
    tools: entry["tools"] as boolean | undefined,
    reasoning: entry["reasoning"] as boolean | undefined,
  };
}

describe("B3 结果落地：只有 found 才写配置，且只写空字段", () => {
  const found = (limit: number): ProbeOutcome => ({
    outcome: "found",
    limit,
    attempts: [{ candidate: 16_384, ok: false, kind: "limit", limit }],
  });

  test("found + 空字段 → 写 max_output_tokens，并记 env 事实与 memo", () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 8_192 })]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, found(32_768));
    expect(r.written).toEqual(["max_output_tokens"]);

    const prov = readSettings(settingsPath).providers[0]!;
    expect(prov["max_output_tokens"]).toBe(32_768);
    expect(prov["max_tokens"]).toBe(8_192);

    expect(readOutputProbeMemo(cfg)).toMatchObject({ outcome: "found", limit: 32_768 });
  });

  test("found + 已手写上限 → skipped，不覆盖", () => {
    const settingsPath = writeSettings([providerEntry({ max_output_tokens: 16_384 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ max_output_tokens: 16_384 }))],
    });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, found(32_768));
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBe(16_384);
  });

  test("inconclusive → 不写配置，只记 memo", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, {
      outcome: "inconclusive",
      reason: "opaque",
      attempts: [{ candidate: 8_192, ok: false, kind: "opaque" }],
    });
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBeUndefined();
    expect(readOutputProbeMemo(cfg)).toMatchObject({ outcome: "inconclusive", reason: "opaque" });
  });

  test("lower_bound → 不写配置，memo 记 atLeast", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, {
      outcome: "lower_bound",
      atLeast: 32_768,
      attempts: [{ candidate: 32_768, ok: true }],
    });
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBeUndefined();
    expect(readOutputProbeMemo(cfg)).toMatchObject({ outcome: "lower_bound", atLeast: 32_768 });
  });
});

describe("A 免费证据入账：请求报错里学到的上限直接落盘", () => {
  test("空字段 → 写 max_output_tokens + env 事实", () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 8_192 })]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = persistLearnedOutputLimit(cfg, 24_576, "max tokens > 24576");
    expect(r.written).toEqual(["max_output_tokens"]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBe(24_576);
    expect(readSettings(settingsPath).providers[0]!["max_tokens"]).toBe(8_192);
  });

  test("已手写 → 不覆盖", () => {
    const settingsPath = writeSettings([providerEntry({ max_output_tokens: 65_536 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ max_output_tokens: 65_536 }))],
    });
    writeBaseSnapshot(cfg);

    const r = persistLearnedOutputLimit(cfg, 24_576, "max tokens > 24576");
    expect(r.written).toEqual([]);
  });

  test("llm 学到上限时回调监听器（chat 路径），并在 reset 后不再回调", async () => {
    const seen: number[] = [];
    setMaxTokensLimitLearnedHandler((e) => seen.push(e.limit));
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("nope", { status: 404 });
        }
        calls += 1;
        if (calls === 1) {
          return Response.json({ error: { message: "max tokens > 4096" } }, { status: 400 });
        }
        await req.text();
        return Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      },
    });
    try {
      const cfg = makeCfg({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        maxTokens: 32_768,
        retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 5000, streamIdleTimeoutMs: 5000 },
      });
      await chat(cfg, [{ role: "user", content: "hi" }]);
      expect(seen).toEqual([4096]);
      resetMaxTokensLimitLearnedHandler();
      resetLearnedMaxTokens();
      await chat({ ...cfg, maxTokens: 32_768 }, [{ role: "user", content: "hi" }]);
      expect(seen).toEqual([4096]);
    } finally {
      server.stop(true);
      resetMaxTokensLimitLearnedHandler();
      resetLearnedMaxTokens();
    }
  });
});
