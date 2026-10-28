/**
 * tests/e2e/settings-fallback.test.ts — `~/.neo/settings.json` 回落（GUI 对接关键项）。
 *
 * 场景：cwd 里**没有** settings.json，只有临时 HOME 下的 `~/.neo/settings.json`
 * （provider 名故意叫 "homefile"，用于证明配置真的来自用户级文件，而不是仓库/默认值）。
 *  - `serve --stdio --cwd <cwd>`：能启动 ready；`settings.get` 返回该 provider 且 key 掩码；
 *  - `hub --cwd <cwd>`：worker 继承同一 HOME，session.create/attach/turn 可跑；
 *    对 worker 转发 `settings.get` 也能看到同一 provider。
 *
 * 这是 GUI 联调的前置：GUI 把 settings 放 `~/.neo/settings.json`，core 必须能回落加载。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FAKE_API_KEY,
  TestEnv,
  WsClient,
  serveStdioAvailable,
  startHub,
  type HubCore,
} from "../helpers.ts";

const available = await serveStdioAvailable();
if (!available) console.warn("[e2e/settings-fallback] serve 尚未可用：已跳过");

const TIMEOUT = 60000;
const PROVIDER = "homefile";

describe.skipIf(!available)("~/.neo/settings.json 回落", () => {
  let env: TestEnv | null = null;
  let hub: HubCore | null = null;
  let client: WsClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    if (hub) {
      await hub.stop().catch(() => {});
      hub = null;
    }
    const current = env;
    env = null;
    if (current) await current.dispose();
  });

  test(
    "stdio：cwd 无 settings.json，用户级 ~/.neo/settings.json 生效（ready + settings.get 掩码）",
    async () => {
      env = await TestEnv.create("settings-home-stdio", {
        scenario: "tool-then-answer",
        settingsMode: "home",
        settingsProviderName: PROVIDER,
      });
      await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");

      // 前置：cwd 里没有 settings.json（harness 在 startCore 时才写用户级文件）。
      expect(existsSync(join(env.dirs.work, "settings.json"))).toBe(false);

      const core = await env.startCore();
      expect(existsSync(join(env.dirs.work, "settings.json")), "cwd 不应出现 settings.json").toBe(false);
      expect(existsSync(join(env.dirs.home, ".neo", "settings.json")), "用户级 settings.json 未写入").toBe(true);
      const ready = await core.ready();
      expect(ready.v).toBe(1);
      expect(ready.protocolVersion).toBe("1.2");

      const res = await core.requestOk({ type: "settings.get" });
      const settings = (res.data as any)?.settings;
      expect(settings).toBeTruthy();
      expect(settings.defaultProvider).toBe(PROVIDER);
      expect(Array.isArray(settings.providers)).toBe(true);
      expect(settings.providers[0].providerName).toBe(PROVIDER);
      // 掩码：不得出现明文 key（文件里写的是 FAKE_API_KEY）。
      expect(typeof settings.providers[0].apiKeyMask).toBe("string");
      expect(settings.providers[0].apiKeyMask).not.toBe(FAKE_API_KEY);
      expect(JSON.stringify(settings)).not.toContain(FAKE_API_KEY);
      // 配置确实能驱动完整一轮（不是只读启动成功）。
      const mark = core.mark();
      await core.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "home-settings-1" }, { since: mark });
      const end = await core.awaitTurnEnd(mark);
      expect(end.event.type).toBe("stats");
      expect((end.event as any).error ?? null).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "hub：worker 继承临时 HOME，cwd 无 settings.json 也能 create/attach/turn",
    async () => {
      env = await TestEnv.create("settings-home-hub", {
        scenario: "tool-then-answer",
        settingsMode: "home",
        settingsProviderName: PROVIDER,
      });
      await writeFile(join(env.dirs.work, "a.txt"), "hello\n", "utf8");
      expect(existsSync(join(env.dirs.work, "settings.json"))).toBe(false);

      hub = await startHub({
        dirs: env.dirs,
        fake: env.fake,
        settingsMode: "home",
        settingsProviderName: PROVIDER,
      });
      const token = await hub.readToken();
      client = await WsClient.connect({ url: hub.url, token });
      const ready = await client.ready();
      expect(ready.capabilities).toContain("sessions");

      // session.create → attach：worker 能在无 cwd settings.json 的情况下启动（回落 HOME）。
      const created = await client.requestOk({ type: "session.create", title: "home-settings" });
      const sessionId = String((created.data as any)?.sessionId ?? "");
      expect(sessionId.length).toBeGreaterThan(0);
      const mark = client.mark();
      const attached = await client.requestOk({ type: "session.attach", sessionId }, { since: mark });
      expect(attached.data).toMatchObject({ role: "owner" });
      await client.awaitFrame((f) => f.kind === "snapshot", "hub snapshot", { since: mark, timeoutMs: 30000 });

      // 转发 settings.get：worker 也应读到同一用户级 provider。
      const settingsRes = await client.requestOk({ type: "settings.get" });
      const settings = (settingsRes.data as any)?.settings;
      expect(settings?.providers?.[0]?.providerName).toBe(PROVIDER);
      expect(JSON.stringify(settings)).not.toContain(FAKE_API_KEY);

      // 完整一轮（证明 worker 的 LLM 配置可用）。
      const turnMark = client.mark();
      await client.requestOk({ type: "turn.send", text: "看看 a.txt", clientId: "home-hub-1" }, { since: turnMark });
      const end = await client.awaitTurnEnd(turnMark, 40000);
      expect(end.event.type).toBe("stats");
      expect((end.event as any).error ?? null).toBeNull();
    },
    TIMEOUT,
  );
});
