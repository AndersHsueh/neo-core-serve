/**
 * K45a 运行时公共面：本波实际需要的契约 + 诚实占位。
 *
 * 提供：`runtimeApiVersion`、K02 端口类型、`loadRuntimeConfig`、
 * 默认严格 PathPolicy，以及 resources/store 的空/占位 owner。
 *
 * 不提供 `createRuntimeSession` / `send` / `abort` / `dispose` 的运行时实现 ——
 * 那些只以类型存在，避免半真半假的会话门面。本批不登记新进程。
 *
 * 默认严格 core PathPolicy。旧融合若要消费，须由可信宿主显式注入既有
 * policy profile；本工厂不放宽权限，也不改变 neo-cli TUI 默认路径权限。
 *
 * 客户端（neo-tui / GUI / mobile）不得直接依赖本模块；本波也不把这些
 * 符号打进 `compat/v1` 归档。
 */
import {
  loadConfig,
  maskKey,
  type Config,
  type LoadConfigOptions,
} from "../config.ts";
import { createPathPolicy, type PathPolicy } from "../path.ts";
import {
  EMPTY_LIFECYCLE_RESULT,
  NOOP_LIFECYCLE_PORT,
  SESSION_START_SOURCES,
  type CompactTrigger,
  type LifecycleHookResult,
  type LifecyclePort,
  type SessionStartSource,
} from "../ports.ts";

export const runtimeApiVersion = "k45a-wave0";

export {
  EMPTY_LIFECYCLE_RESULT,
  NOOP_LIFECYCLE_PORT,
  SESSION_START_SOURCES,
};
export type {
  CompactTrigger,
  LifecycleHookResult,
  LifecyclePort,
  SessionStartSource,
};
export type {
  AgentEvent,
  AgentIO,
  AgentOptions,
  PermissionMode,
  TurnStats,
} from "../agent/types.ts";

/** 可注入的配置定位器；调用时不 process.chdir。 */
export interface RuntimeConfigLocator {
  settingsDir?: string;
  spawnDir?: string;
  pkgRoot?: string;
  homeDir?: string;
}

export interface LoadRuntimeConfigInput {
  cwd?: string;
  env?: Record<string, string | undefined>;
  locator?: RuntimeConfigLocator;
  settingsDir?: string;
}

/**
 * 受信任宿主的配置加载。不偷偷 chdir。
 * 原始 apiKey 只留给受信任宿主；对外展示请用 `runtimeConfigPublicView`。
 */
export function loadRuntimeConfig(input: LoadRuntimeConfigInput = {}): Config {
  const locator = input.locator ?? {};
  const options: LoadConfigOptions = {
    settingsDir: input.settingsDir ?? locator.settingsDir,
    spawnDir: locator.spawnDir,
    pkgRoot: locator.pkgRoot,
    homeDir: locator.homeDir,
    env: input.env,
  };
  return loadConfig(input.cwd !== undefined ? { cwd: input.cwd } : {}, options);
}

/** 给不可信/展示面用的配置视图：不含原始密钥。 */
export interface RuntimeConfigPublicView {
  providerName: string;
  providerType: Config["providerType"];
  model: string;
  modelTier: Config["modelTier"];
  baseUrl: string;
  cwd: string;
  settingsPath: string | null;
  apiKeyMask: string;
}

export function runtimeConfigPublicView(cfg: Config): RuntimeConfigPublicView {
  return {
    providerName: cfg.providerName,
    providerType: cfg.providerType,
    model: cfg.model,
    modelTier: cfg.modelTier,
    baseUrl: cfg.baseUrl,
    cwd: cfg.cwd,
    settingsPath: cfg.settingsPath,
    apiKeyMask: maskKey(cfg.apiKey),
  };
}

export interface RuntimeResourceOwner {
  kind: "none";
  note: "本批不登记新进程";
}

export const NO_RUNTIME_RESOURCE_OWNER: RuntimeResourceOwner = {
  kind: "none",
  note: "本批不登记新进程",
};

export interface RuntimeStore {
  kind: "placeholder";
  note: "本批不登记新进程";
}

export const NO_RUNTIME_STORE: RuntimeStore = {
  kind: "placeholder",
  note: "本批不登记新进程",
};

/**
 * 路径策略档。本波默认工厂只实现 `strict-core`。
 * `legacy-fusion` 必须由可信宿主显式注入既有策略，不能经此默认工厂放宽。
 */
export type RuntimePolicyProfile = "strict-core" | "legacy-fusion";

export function createRuntimePathPolicy(
  cwd: string,
  profile: RuntimePolicyProfile = "strict-core",
): PathPolicy {
  if (profile !== "strict-core") {
    throw new Error(
      "本波默认工厂只提供 strict-core PathPolicy；legacy-fusion 须由可信宿主显式注入既有策略，不得经此放宽。neo-cli TUI 默认路径权限不变。",
    );
  }
  return createPathPolicy(cwd);
}

/* ------------------------------------------------------------------ */
/* 会话门面：只钉类型，不提供实现                                      */
/* ------------------------------------------------------------------ */

export interface RuntimeSessionHandle {
  readonly id: string;
  readonly cwd: string;
  send: RuntimeSessionSend;
  abort: RuntimeSessionAbort;
  dispose: RuntimeSessionDispose;
}

export type RuntimeSessionSend = (text: string) => Promise<void>;
export type RuntimeSessionAbort = () => void;
export type RuntimeSessionDispose = () => Promise<void> | void;

export interface CreateRuntimeSessionOptions {
  id: string;
  cwd: string;
  config: Config;
  store?: RuntimeStore;
  ports?: { lifecycle?: LifecyclePort };
  resources?: RuntimeResourceOwner;
  /**
   * 路径策略档。不可由不可信客户端任意指定；默认 strict-core。
   * 本波不实现放宽后的 legacy-fusion 工厂。
   */
  policyProfile?: RuntimePolicyProfile;
}

/** 会话装配契约（类型 only）。本波没有同名运行时函数。 */
export type CreateRuntimeSession = (opts: CreateRuntimeSessionOptions) => RuntimeSessionHandle;
