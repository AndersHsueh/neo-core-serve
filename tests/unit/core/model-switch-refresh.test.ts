/**
 * K05b：切换模型后刷新窗口/能力。不迁 /context UI 外观，只锁 helper 语义。
 * 模型切换不得沿用旧探测值；新模型无事实则回落手写配置。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentModelCapabilityView,
  refreshCapabilitiesAfterModelSwitch,
  resolveAndApplyModelWindow,
} from "../../../src/core/env/modelWindows.ts";
import { machineKeyOf, snapshotFile, writeSnapshot } from "../../../src/core/env/probe.ts";
import type { EnvStatic } from "../../../src/core/env/types.ts";
import type { Config } from "../../../src/core/config.ts";
import { sleep } from "../../helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-switch-refresh-"));
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
    baseUrl: "http://127.0.0.1:9/v1",
    model: "m-old",
    modelTier: "default",
    contextWindow: 200_000,
    configuredContextWindow: 200_000,
    contextWindowSource: "config",
    env: {},
    cwd: SANDBOX,
    ...over,
  } as unknown as Config;
}

function writeSnapshotWithModels(models: Record<string, unknown>): void {
  const key = machineKeyOf(hostname(), platform(), arch());
  const file = snapshotFile(SANDBOX, key, {});
  writeSnapshot(file, {
    version: 1,
    collectedAt: new Date().toISOString(),
    machineKey: key,
    shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
    models,
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

describe("refreshCapabilitiesAfterModelSwitch：同步段", () => {
  test("切到新模型后 cfg.contextWindow 立刻变成新模型的 env 缓存值", () => {
    writeSnapshotWithModels({
      "p1|m-old": { contextWindow: 200_000, source: "models_api", updatedAt: "t" },
      "p1|m-new": { contextWindow: 131_072, maxOutputTokens: 32_768, source: "models_api", updatedAt: "t" },
    });

    const cfg = makeCfg();
    resolveAndApplyModelWindow(cfg);
    expect(cfg.contextWindow).toBe(200_000);

    cfg.model = "m-new";
    const applied = refreshCapabilitiesAfterModelSwitch(cfg);

    expect(applied.tokens).toBe(131_072);
    expect(applied.source).toBe("models_api");
    expect(cfg.contextWindow).toBe(131_072);
    expect(cfg.contextWindowSource).toBe("models_api");
    expect(currentModelCapabilityView(cfg).contextWindow).toBe("131,072 tokens");
    expect(currentModelCapabilityView(cfg).maxOutputTokens).toBe("32,768 tokens");
  });

  test("新模型没有 env 事实 → 回落到 settings 手写值，而不是旧模型残留", () => {
    writeSnapshotWithModels({
      "p1|m-old": { contextWindow: 200_000, source: "models_api", updatedAt: "t" },
    });

    const cfg = makeCfg({ contextWindow: 200_000, configuredContextWindow: 64_000 });
    resolveAndApplyModelWindow(cfg);
    expect(cfg.contextWindow).toBe(200_000);

    cfg.model = "m-unknown";
    refreshCapabilitiesAfterModelSwitch(cfg);

    expect(cfg.contextWindow).toBe(64_000);
    expect(cfg.contextWindowSource).toBe("config");
  });

  test("provider 切换同样生效（key 含 provider 名）", () => {
    writeSnapshotWithModels({
      "p1|m1": { contextWindow: 100_000, source: "models_api", updatedAt: "t" },
      "p2|m1": { contextWindow: 400_000, source: "models_api", updatedAt: "t" },
    });

    const cfg = makeCfg({ model: "m1" });
    resolveAndApplyModelWindow(cfg);
    expect(cfg.contextWindow).toBe(100_000);

    cfg.providerName = "p2";
    refreshCapabilitiesAfterModelSwitch(cfg);
    expect(cfg.contextWindow).toBe(400_000);
  });
});

describe("refreshCapabilitiesAfterModelSwitch：异步探测", () => {
  test("探测完成后再次解析，cfg 更新到 /models 的值", async () => {
    writeSnapshotWithModels({});
    const s = serveModels({ id: "m-probe", context_length: 262_144, max_output_tokens: 8_192 });
    try {
      const cfg = makeCfg({
        model: "m-probe",
        contextWindow: 32_000,
        configuredContextWindow: 32_000,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
      });
      const applied = refreshCapabilitiesAfterModelSwitch(cfg);
      expect(applied.source).toBe("config");
      expect(cfg.contextWindow).toBe(32_000);

      for (let i = 0; i < 40 && cfg.contextWindow !== 262_144; i += 1) await sleep(50);
      expect(cfg.contextWindow).toBe(262_144);
      expect(cfg.contextWindowSource).toBe("models_api");
      expect(currentModelCapabilityView(cfg).maxOutputTokens).toBe("8,192 tokens");
    } finally {
      s.stop();
    }
  });

  test("探测失败静默：不抛错、不改变同步结果", async () => {
    writeSnapshotWithModels({
      "p1|m-x": { contextWindow: 50_000, source: "models_api", updatedAt: "t" },
    });
    const cfg = makeCfg({ model: "m-x", baseUrl: "http://127.0.0.1:9/v1" });
    refreshCapabilitiesAfterModelSwitch(cfg);
    expect(cfg.contextWindow).toBe(50_000);
    await sleep(150);
    expect(cfg.contextWindow).toBe(50_000);
    expect(cfg.contextWindowSource).toBe("models_api");
  });
});
