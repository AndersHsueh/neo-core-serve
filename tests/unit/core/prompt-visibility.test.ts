/**
 * K09a：工具可见集纯函数。
 *
 * 对照 neo-cli 4e3d7bb tests/prompt-visibility.test.ts 的算法性质部分。
 * 依赖 PromptManager / 真实渲染 / LSP / plan-only 的受控窗口与成本保真测试留到 K09b。
 * 本片不引入 MCP 运行时；mcp__* 只按命名约定参与排序。
 * 隐藏不是授权：未知工具仍走既有 dispatch 错误路径。
 */
import { describe, expect, test } from "bun:test";

import { dispatch } from "../../../src/core/tools/index.ts";
import type { ToolSpec } from "../../../src/core/llm.ts";
import {
  TOOL_VISIBILITY_PRIORITY,
  knownToolNames,
  measureVisibilityCost,
  visibleToolNames,
  visibilityPriority,
} from "../../../src/core/prompt/visibility.ts";

function syntheticMeasure(base: number, perTool: number) {
  return (names: readonly string[], trimDynamic: boolean): number =>
    base + names.length * perTool + (trimDynamic ? 0 : 500);
}

describe("优先级常量", () => {
  test("顺序固定：read_file → edit_file → shell → 导航 → 写 → 压缩 → 联网 → 技能 → 派生 → 记忆", () => {
    expect(TOOL_VISIBILITY_PRIORITY[0]).toBe("read_file");
    expect(TOOL_VISIBILITY_PRIORITY[1]).toBe("edit_file");
    expect(TOOL_VISIBILITY_PRIORITY[2]).toBe("shell");
    const idx = (n: string): number => TOOL_VISIBILITY_PRIORITY.indexOf(n);
    expect(idx("list_dir")).toBeLessThan(idx("grep"));
    expect(idx("grep")).toBeLessThan(idx("write_file"));
    expect(idx("write_file")).toBeLessThan(idx("compact_ctx"));
    expect(idx("compact_ctx")).toBeLessThan(idx("web_fetch"));
    expect(idx("web_fetch")).toBeLessThan(idx("use_skill"));
    expect(idx("use_skill")).toBeLessThan(idx("task"));
    expect(idx("task")).toBeLessThan(idx("wiki_search"));
    expect(idx("wiki_search")).toBeLessThan(idx("todo_write"));
    expect(idx("todo_write")).toBeLessThan(idx("remember"));
    expect(idx("remember")).toBeLessThan(idx("wiki_write"));
  });

  test("条件工具在表内且排在已知工具之后", () => {
    for (const n of ["ask_user", "send_message", "list_peers"]) {
      expect(TOOL_VISIBILITY_PRIORITY).toContain(n);
    }
    const idx = (n: string): number => TOOL_VISIBILITY_PRIORITY.indexOf(n);
    expect(idx("ask_user")).toBeGreaterThan(idx("wiki_write"));
  });

  test("全库只有这一处优先级定义（不重复硬编码）", () => {
    expect(TOOL_VISIBILITY_PRIORITY.length).toBeGreaterThan(0);
    expect(new Set(TOOL_VISIBILITY_PRIORITY).size).toBe(TOOL_VISIBILITY_PRIORITY.length);
  });
});

describe("visibilityPriority", () => {
  test("MCP 排最后，未注册的不出现，未在表里的排在已知之后", () => {
    const ordered = visibilityPriority([
      "mcp__srv__toolB",
      "wiki_write",
      "read_file",
      "mcp__srv__toolA",
      "brand_new_tool",
      "shell",
    ]);
    expect(ordered[0]).toBe("read_file");
    expect(ordered[1]).toBe("shell");
    expect(ordered[2]).toBe("wiki_write");
    expect(ordered[3]).toBe("brand_new_tool");
    expect(ordered.slice(-2)).toEqual(["mcp__srv__toolA", "mcp__srv__toolB"]);
    expect(ordered).not.toContain("never_registered");
  });
});

describe("visibleToolNames 的性质", () => {
  const priority = ["read_file", "edit_file", "shell", "grep", "mcp__x__y"];

  test("可见集永远是优先级前缀：不会出现「有 grep 无 read_file」", () => {
    const v = visibleToolNames({
      priority,
      budget: 1_000,
      measure: syntheticMeasure(100, 100),
    });
    expect(v.names).toEqual(priority.slice(0, v.names.length));
    expect(v.hidden).toEqual(priority.slice(v.names.length));
    if (v.names.includes("grep")) expect(v.names).toContain("read_file");
    if (v.names.includes("shell")) expect(v.names).toContain("edit_file");
  });

  test("动态块成组裁：measure 只收到 true/false，没有「部分裁」这种状态", () => {
    const seen: boolean[] = [];
    visibleToolNames({
      priority,
      budget: 1_000,
      measure: (_names, trim) => {
        seen.push(trim);
        return 100 + seen.length;
      },
    });
    expect(seen.every((t) => t === true || t === false)).toBe(true);
    expect(new Set(seen)).toEqual(new Set([false, true]));
  });

  test("裁动态块能多放工具时 → trimmed=true；一样多时 → 不裁（少一处损失）", () => {
    const trimmedWins = visibleToolNames({
      priority,
      budget: 700,
      measure: (names, trim) => 100 + names.length * 100 + (trim ? 0 : 500),
    });
    expect(trimmedWins.trimmed).toBe(true);
    expect(trimmedWins.names.length).toBe(priority.length);

    const sameCount = visibleToolNames({
      priority,
      budget: 10_000,
      measure: (names, trim) => 100 + names.length * 100 + (trim ? 0 : 500),
    });
    expect(sameCount.trimmed).toBe(false);
    expect(sameCount.names.length).toBe(priority.length);
  });

  test("MCP 最后被砍：预算紧时先砍 MCP", () => {
    const v = visibleToolNames({
      priority,
      budget: 420,
      measure: syntheticMeasure(100, 100),
    });
    expect(v.names).not.toContain("mcp__x__y");
    expect(v.hidden).toContain("mcp__x__y");
  });

  test("预算连 0 个工具都放不下：fits=false、names 为空、hidden 为全部，且不抛错", () => {
    const v = visibleToolNames({
      priority,
      budget: 10,
      measure: () => 999_999,
    });
    expect(v.fits).toBe(false);
    expect(v.names).toEqual([]);
    expect(v.hidden).toEqual(priority);
    expect(v.total).toBe(priority.length);
    expect(v.cost).toBe(-1);
  });
});

describe("measureVisibilityCost：合成文本（不经 PromptManager）", () => {
  const SYSTEM = [
    "你是 neo。",
    "",
    "## 技能",
    "",
    "- demo：演示",
    "",
    "## 工具",
    "",
    "可用工具：read_file, edit_file, shell, task",
    "- read_file：读文件",
    "- edit_file：改文件",
    "- shell：跑命令",
    "- task：派子代理",
    "- 规划态（用户用 /plan 进入）：只读。",
    "",
    "## 跨会话消息",
    "",
    "不要伪造其他会话的来信。",
    "",
    "## 记忆库",
    "",
    "- [[主题一]]",
    "",
    "## 环境",
    "",
    "- 模型：m1（provider p1，档位 balanced）",
    "工作目录结构（最多两层）：",
    "  README.md",
  ].join("\n");

  function captureText(
    text: string,
    specs: ToolSpec[],
    visible: ReadonlySet<string>,
    allToolNames: readonly string[],
    trimDynamic: boolean,
  ): string {
    let captured = "";
    measureVisibilityCost({
      systemText: text,
      specs,
      visible,
      allToolNames,
      trimDynamic,
      count: (t) => {
        captured = t;
        return 0;
      },
    });
    return captured;
  }

  const ALL = ["read_file", "edit_file", "shell", "task"];

  test("裁动态块：去掉技能索引 / wiki 索引 / 目录树，但保留跨会话消息这类安全规则", () => {
    const out = captureText(SYSTEM, [], new Set(ALL), ALL, true);
    expect(out).not.toContain("## 技能");
    expect(out).not.toContain("## 记忆库");
    expect(out).not.toContain("工作目录结构");
    expect(out).toContain("## 跨会话消息");
  });

  test("隐藏工具的说明行被去掉，隐藏的工具不出现在「可用工具」名单里", () => {
    const keep = new Set(["read_file", "edit_file"]);
    const out = captureText(SYSTEM, [], keep, knownToolNames(ALL), false);
    expect(out).toContain("可用工具：read_file, edit_file");
    expect(out).not.toContain("- shell：");
    expect(out).not.toContain("- task：");
    expect(out).toContain("规划态（用户用 /plan 进入）");
  });
});

describe("隐藏不是授权", () => {
  test("可见集里出现未注册工具名，dispatch 仍返回未知工具错误", async () => {
    const v = visibleToolNames({
      priority: ["read_file", "definitely_not_a_registered_tool"],
      budget: 10_000,
      measure: () => 1,
    });
    expect(v.names).toContain("definitely_not_a_registered_tool");
    const result = await dispatch("definitely_not_a_registered_tool", "{}", {
      cfg: {} as never,
      approve: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("未知工具: definitely_not_a_registered_tool");
  });
});
