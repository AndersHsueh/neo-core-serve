/**
 * Agent 输出格式小函数（从 agent.ts 抽出，行为不变）。
 */
import { renderMarkdown } from "../ui/render.ts";

export function truncateArgs(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export function previewArgs(s: string): string {
  return truncateArgs(s, 100);
}

/** 渲染一次完整的助手回答（用于历史回放 / 导出）。 */
export function renderFinal(md: string, width = 100): string {
  return renderMarkdown(md, width);
}
