/**
 * tests/unit/serve-contract.test.ts — v0.0.1 服务契约的单点验证（真实 stdio 进程）。
 *
 * 覆盖主机边界上最容易腐化的几条：
 *  - 命令子集：help/tier/mode/cost/context/compact/clear 被路由；未知命令报 protocol 错。
 *  - 审批超时收敛：注入 MATRIX_CORE_APPROVAL_TIMEOUT_MS 后 by=timeout、轮继续、会话回 idle。
 *  - settings.get 掩码：apiKeyMask 不含明文；协议帧/stderr/transcript/日志都不泄露 key。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FAKE_API_KEY,
  TestEnv,
  findTranscript,
  serveStdioAvailable,
  type Frame,
  type TestEnvOptions,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[unit/serve-contract] serve --stdio 尚未可用：跳过");

const TIMEOUT = 30000;

function ok(frame: Frame): Frame {
  expect(frame.ok, `命令失败：${JSON.stringify(frame.error)}`).toBe(true);
  return frame;
}

/**
 * 失败判定：协议允许两种编码 ——
 *  - serve 层拒绝（settings.patch / session.close）：信封 ok:false + error；
 *  - core 命令失败（command.run）：信封 ok:true + data.ok:false + data.error（协议 §4.1）。
 * 两者都必须给出可机读的 error.code，不能静默成功。
 */
function fail(frame: Frame): Frame {
  if (frame.ok === false) {
    expect(typeof frame.error?.code).toBe("string");
    return frame;
  }
  const data = frame.data as any;
  expect(data?.ok, `命令应失败却返回成功：${JSON.stringify(data)}`).toBe(false);
  expect(typeof data?.error?.code).toBe("string");
  return frame;
}

describe.skipIf(!available)("命令子集与错误码", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });
  async function start(name: string, options: TestEnvOptions = {}) {
    env = await TestEnv.create(name, options);
    return env.startCore();
  }

  test(
    "help/tier/mode/cost/context/compact/clear 被路由；未知命令与不支持命令报错",
    async () => {
      const core = await start("commands");

      // help：返回结果块。
      const help = ok(await core.request({ type: "command.run", name: "help", args: [] }));
      const helpData = help.data as any;
      expect(helpData.ok).toBe(true);
      expect(Array.isArray(helpData.blocks)).toBe(true);
      expect(helpData.blocks.length).toBeGreaterThan(0);

      // tier：切到 fast，changes 或随后的 session.meta 必须体现。
      const tierMark = core.mark();
      const tier = ok(await core.request({ type: "command.run", name: "tier", args: ["fast"] }, { since: tierMark }));
      const tierChanges = (tier.data as any)?.changes;
      const metaFrame = await core
        .awaitFrame(
          (f) => f.kind === "event" && f.event?.type === "session.meta",
          "tier 后的 session.meta",
          { since: tierMark, timeoutMs: 8000 },
        )
        .catch(() => null);
      const metaTier = metaFrame?.event?.meta?.tier;
      expect(tierChanges?.tier === "fast" || metaTier === "fast", "tier fast 未生效").toBe(true);

      // mode：切到 plan，按协议 §4.1 广播 session.meta。
      const modeMark = core.mark();
      const mode = ok(await core.request({ type: "command.run", name: "mode", args: ["plan"] }, { since: modeMark }));
      const modeMeta = await core.awaitEvent("session.meta", (ev) => ev.meta?.mode === "plan", {
        since: modeMark,
        timeoutMs: 8000,
      });
      expect((mode.data as any)?.changes?.mode === "plan" || modeMeta.event.meta.mode === "plan").toBe(true);

      // mode.set 命令同样生效。
      const setMark = core.mark();
      ok(await core.request({ type: "mode.set", mode: "ask" }, { since: setMark }));
      await core.awaitEvent("session.meta", (ev) => ev.meta?.mode === "ask", { since: setMark, timeoutMs: 8000 });

      // cost / context / compact / clear：必须被路由且不崩（ok 布尔值即可，业务语义不强断言）。
      for (const name of ["cost", "context", "compact"]) {
        const res = await core.request({ type: "command.run", name, args: [] });
        expect(res.kind).toBe("result");
        expect(typeof (res.data as any)?.ok).toBe("boolean");
      }
      const clearMark = core.mark();
      const clear = ok(await core.request({ type: "command.run", name: "clear", args: [] }, { since: clearMark }));
      expect((clear.data as any)?.ok).toBe(true);
      await core.awaitEvent("session.cleared", undefined, { since: clearMark });

      // 未知命令：必须报错且错误码是协议/找不到类，不能静默成功。
      const unknown = fail(await core.request({ type: "command.run", name: "no-such-command-xyz", args: [] }));
      const unknownError = unknown.error ?? (unknown.data as any)?.error;
      expect(typeof unknownError?.message).toBe("string");
      expect((unknown.data as any)?.ok).not.toBe(true);

      // v0.0.1 明确不支持的命令：settings.patch / session.close。
      fail(await core.request({ type: "settings.patch", patch: { showReasoning: false } }));
      fail(await core.request({ type: "session.close" }));

      expect(core.nonJsonStdout).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "审批超时收敛：by=timeout、tool.end=denied、stats 收口、会话回 idle 可继续",
    async () => {
      const core = await start("approval-timeout-contract", {
        scenario: "write-then-answer",
        env: { MATRIX_CORE_APPROVAL_TIMEOUT_MS: "250" },
      });

      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "写个文件", clientId: "timeout-1" }, { since: mark });
      const req = await core.awaitEvent("approval.request", undefined, { since: mark, timeoutMs: 15000 });

      const started = Date.now();
      const resolved = await core.awaitEvent("approval.resolve", (ev) => ev.blockId === req.event.blockId, {
        since: mark,
        timeoutMs: 15000,
      });
      const elapsed = Date.now() - started;
      expect(resolved.event.state).toBe("denied");
      expect(resolved.event.by).toBe("timeout");
      // 超时注入应真的生效（远小于默认 120s；宽松上界防 CI 抖动）。
      expect(elapsed).toBeLessThan(10000);

      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      const toolEnd = core
        .eventsSince(mark)
        .find((f) => f.event?.type === "tool.end")?.event;
      expect(toolEnd?.state).toBe("denied");

      await core.awaitEvent("session.status", (ev) => ev.status === "idle", { since: mark, timeoutMs: 10000 });
      // 会话可继续接帧（未卡死）：再 attach 一次拿快照。
      const mark2 = core.mark();
      ok(await core.request({ type: "session.attach" }, { since: mark2 }));
      await core.awaitFrame((f) => f.kind === "snapshot", "超时后 snapshot", { since: mark2 });
    },
    TIMEOUT,
  );
});

describe.skipIf(!available)("settings.get 掩码与密钥不出 core", () => {
  let env: TestEnv | null = null;
  afterEach(async () => {
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "apiKeyMask 不含明文；协议帧/stderr/transcript/日志无明文 key",
    async () => {
      env = await TestEnv.create("settings-mask");
      const core = await env.startCore();
      const ready = await core.ready();

      const res = ok(await core.request({ type: "settings.get" }));
      const settings = (res.data as any)?.settings;
      expect(settings).toBeTruthy();
      expect(settings.defaultProvider).toBe("fake");
      expect(Array.isArray(settings.providers)).toBe(true);
      expect(settings.providers.length).toBeGreaterThanOrEqual(1);
      for (const provider of settings.providers) {
        expect(typeof provider.apiKeyMask).toBe("string");
        expect(provider.apiKeyMask).not.toBe(FAKE_API_KEY);
        expect(provider.apiKeyMask).not.toContain("SECRET");
      }
      expect(JSON.stringify(settings)).not.toContain(FAKE_API_KEY);

      // 跑一轮让日志/transcript/事件都产生内容。
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "你好", clientId: "mask-1" }, { since: mark });
      await core.awaitTurnEnd(mark);

      expect(JSON.stringify(core.frames)).not.toContain(FAKE_API_KEY);
      expect(core.stderrText).not.toContain(FAKE_API_KEY);

      const transcriptPath = await findTranscript(env.dirs, ready.sessionId as string);
      expect(transcriptPath, "找不到 transcript 文件").not.toBeNull();
      expect(await readFile(transcriptPath as string, "utf8")).not.toContain(FAKE_API_KEY);

      // 整个测试根目录（除测试自己写的 settings.json 输入）都不得出现明文。
      const allowed = join(env.dirs.work, "settings.json");
      const leaks: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile() && full !== allowed) {
            const text = await readFile(full, "utf8").catch(() => "");
            if (text.includes(FAKE_API_KEY)) leaks.push(full);
          }
        }
      };
      await walk(env.dirs.root);
      expect(leaks, `明文 key 泄露到：${leaks.join(", ")}`).toEqual([]);
    },
    TIMEOUT,
  );
});
