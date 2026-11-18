/**
 * core/paths.ts — `~/.neo` 下所有路径的**唯一真源**（v0.0.2）。
 *
 * 为什么集中：v0.0.1 里 sessions/transcripts/run/locks 的路径散落在
 * session-host、session、auth、turnDiagnostics 各处，各自读自己的 `NEO_*`
 * 覆盖变量。路径一改就要全仓搜索，且很容易漏掉一处（例如 lock 还写老位置）。
 *
 * 约定：
 *  - 所有函数都接受 `env` 参数（默认 `process.env`），方便测试注入；
 *  - 覆盖变量优先级：具体变量（NEO_SESSIONS_DIR…）→ `NEO_HOME` → `~/.neo`；
 *  - 只计算路径，**不创建目录**、不读文件（纯函数，可安全在测试里断言）。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type EnvLike = NodeJS.ProcessEnv;

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** `~/.neo`（`NEO_HOME` 可覆盖，测试隔离用）。 */
export function neoHome(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_HOME"]) ?? join(homedir(), ".neo");
}

/** 会话 JSON 目录：`~/.neo/sessions`（`NEO_SESSIONS_DIR` 覆盖）。 */
export function sessionsDir(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_SESSIONS_DIR"]) ?? join(neoHome(env), "sessions");
}

/** transcript 目录：默认 `sessions/transcripts`（`NEO_TRANSCRIPTS_DIR` 覆盖）。 */
export function transcriptsDir(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_TRANSCRIPTS_DIR"]) ?? join(sessionsDir(env), "transcripts");
}

/** `<sessions>/<id>.json` —— 从 id 重算，绝不信任文件里的 meta.path。 */
export function sessionPath(id: string, env: EnvLike = process.env): string {
  return join(sessionsDir(env), `${id}.json`);
}

/** `<transcripts>/<id>.ndjson`。 */
export function transcriptPath(id: string, env: EnvLike = process.env): string {
  return join(transcriptsDir(env), `${id}.ndjson`);
}

/** 会话附件目录：`<sessions>/attachments/<id>`。 */
export function attachmentsDir(sessionId: string, env: EnvLike = process.env): string {
  return join(sessionsDir(env), "attachments", sessionId);
}

/** 运行期目录：`~/.neo/run`（`NEO_RUN_DIR` 覆盖）。 */
export function runDir(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_RUN_DIR"]) ?? join(neoHome(env), "run");
}

/** 会话锁根目录：`<run>/locks`。 */
export function locksDir(env: EnvLike = process.env): string {
  return join(runDir(env), "locks");
}

/** 单会话锁目录：`<run>/locks/<id>`。 */
export function lockDir(sessionId: string, env: EnvLike = process.env): string {
  return join(locksDir(env), sessionId);
}

/** 本地 token：`<run>/core.token`（`NEO_TOKEN_FILE` 覆盖，便于 `--token-file` 对齐）。 */
export function tokenFile(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_TOKEN_FILE"]) ?? join(runDir(env), "core.token");
}

/** 发现文件：`<run>/core.json`（`NEO_RUN_FILE` 覆盖，便于测试并行）。 */
export function runFile(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_RUN_FILE"]) ?? join(runDir(env), "core.json");
}

/** 结构化日志目录：`~/.neo/logs`（`NEO_LOG_DIR` 覆盖）。 */
export function logsDir(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_LOG_DIR"]) ?? join(neoHome(env), "logs");
}

/** 单实例锁目录：`<run>/core.lock`。 */
export function instanceLockDir(env: EnvLike = process.env): string {
  return join(runDir(env), "core.lock");
}

/** Hub/daemon 日志目录：`<logs>/core`（`NEO_CORE_LOG_DIR` 可覆盖）。 */
export function coreLogsDir(env: EnvLike = process.env): string {
  return nonEmpty(env["NEO_CORE_LOG_DIR"]) ?? join(logsDir(env), "core");
}
