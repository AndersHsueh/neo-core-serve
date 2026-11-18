/**
 * K05a：输出上限探测的纯判定与有界阶梯。默认不探；假 request，不连真实模型。
 * 写回 settings 放在 K05b。C1 解析已由 K03b 覆盖，这里不重复 loadConfig 集成。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_OUTPUT_PROBE, type Config } from "../../../src/core/config.ts";
import {
  OUTPUT_PROBE_MEMO_TTL_DAYS,
  classifyProbeError,
  probeCandidates,
  readOutputProbeMemo,
  recordOutputLimitFact,
  runOutputProbe,
  shouldRunOutputProbe,
  type OutputProbeSettings,
} from "../../../src/core/env/outputProbe.ts";
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
