/**
 * Prompt 路径上的 MCP 计量辅助（K09b / issue #68）。
 *
 * 只回答「哪些 MCP schema 应计入档位与可见集开销」。
 * 不启动 MCP server、不注册 tool_search 运行时、不改权限、不发动态工具协议广告。
 *
 * 默认与 4e3d7bb「无 MCP 配置」同一口径：mcpServers=[]，mcp.toolSearch="auto"、
 * 阈值为 10；没有 MCP 工具时延迟加载不会启用。
 */
import type { Config } from "../config.ts";
import type { ToolSpec } from "../llm.ts";
import { MCP_TOOL_PREFIX, isMcpToolName } from "./visibility.ts";

/** 搜索工具名（第一方工具，不是 MCP 工具）。本波不实现其运行时。 */
export const TOOL_SEARCH_NAME = "tool_search";

/** 规划态控制工具：非规划态不进请求，选档时也不计入开销。 */
export const PLAN_CONTROL_TOOLS: readonly string[] = ["submit_plan", "exit_plan_mode"];

export interface McpPromptConfig {
  toolSearch: "auto" | boolean;
  toolSearchThreshold: number;
}

export const DEFAULT_MCP_CONFIG: McpPromptConfig = { toolSearch: "auto", toolSearchThreshold: 10 };

/** 计量只需要名字与 alwaysLoad；transport/command/url 故意不在这里解析或执行。 */
export interface McpServerMetering {
  name: string;
  alwaysLoad?: boolean;
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const i = rest.indexOf("__");
  if (i <= 0 || i + 2 >= rest.length) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

export function mcpConfigOf(cfg: Config): McpPromptConfig {
  const m = cfg.mcp;
  return {
    toolSearch: m?.toolSearch ?? DEFAULT_MCP_CONFIG.toolSearch,
    toolSearchThreshold: m?.toolSearchThreshold ?? DEFAULT_MCP_CONFIG.toolSearchThreshold,
  };
}

export function isAlwaysLoadServer(cfg: Config, server: string): boolean {
  const list: McpServerMetering[] = cfg.mcpServers ?? [];
  return list.some((s) => s.name === server && s.alwaysLoad === true);
}

export interface McpToolClass {
  name: string;
  server: string | null;
  alwaysLoad: boolean;
}

export function classifyMcpTools(cfg: Config, specs: readonly ToolSpec[]): McpToolClass[] {
  const out: McpToolClass[] = [];
  for (const s of specs) {
    const name = s.function.name;
    if (!isMcpToolName(name)) continue;
    const parsed = parseMcpToolName(name);
    const server = parsed?.server ?? null;
    out.push({ name, server, alwaysLoad: server !== null && isAlwaysLoadServer(cfg, server) });
  }
  return out;
}

export function deferrableMcpNames(cfg: Config, specs: readonly ToolSpec[]): string[] {
  return classifyMcpTools(cfg, specs)
    .filter((t) => !t.alwaysLoad)
    .map((t) => t.name);
}

export function toolSearchEnabled(cfg: Config, specs: readonly ToolSpec[]): boolean {
  const { toolSearch, toolSearchThreshold } = mcpConfigOf(cfg);
  if (toolSearch === true) return true;
  if (toolSearch === false) return false;
  return deferrableMcpNames(cfg, specs).length >= toolSearchThreshold;
}

/**
 * 该工具名在当前 cfg 下是否会带 schema 进请求。
 * 不传 allSpecs 时无法判断延迟是否启用，调用方应传入与 requestSpecs 同一份清单。
 */
export function mcpVisibleInRequest(
  cfg: Config,
  name: string,
  loaded: ReadonlySet<string>,
  allSpecs: readonly ToolSpec[],
): boolean {
  const enabled = toolSearchEnabled(cfg, allSpecs);
  if (name === TOOL_SEARCH_NAME) return enabled;
  if (!isMcpToolName(name)) return true;
  if (!enabled) return true;
  const cls = classifyMcpTools(cfg, allSpecs).find((t) => t.name === name);
  if (!cls || cls.server === null) return true;
  return cls.alwaysLoad || loaded.has(name);
}

export function requestSpecs(
  cfg: Config,
  loaded: readonly string[],
  allSpecs: readonly ToolSpec[],
): ToolSpec[] {
  const set = new Set(loaded);
  return allSpecs.filter(
    (s) =>
      !PLAN_CONTROL_TOOLS.includes(s.function.name) &&
      mcpVisibleInRequest(cfg, s.function.name, set, allSpecs),
  );
}

export function normalizeLoaded(loaded: ReadonlySet<string> | Iterable<string> | undefined): string[] {
  if (!loaded) return [];
  return [...new Set(loaded)].sort();
}
