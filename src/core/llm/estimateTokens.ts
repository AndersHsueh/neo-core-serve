/**
 * 粗略 token 估算：ASCII 约 4 字符/token，CJK 约 1.5 字符/token。
 *
 * 从 llm.ts 抽出，供 prompt/tokens 等纯叶打包，不把请求层打进 compat 归档。
 * 这里只用结构类型，不 import llm.ts，避免打包图把 Config/fetch 拉进来。
 */

export interface EstimateMessage {
  content?: string | ReadonlyArray<{ type: string; text?: string }> | null;
  tool_calls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
}

/** 粗略 token 估算：ASCII 约 4 字符/token，CJK 约 1.5 字符/token。 */
export function estimateTokens(messages: EstimateMessage[], tools: readonly unknown[] = []): number {
  // 逐段累积「文本」与「字符数」两样东西：
  // 字符数用于算ASCII 份额，文本本身用于数 CJK。
  // 早期版本把字符数（number）当文本传给 countCjk，String(number) 后再数 CJK 恒为 0，
  // 于是中文被按 4 字符/token 计，低估约 2.7 倍 —— 压缩触发点因此严重偏晚。
  let chars = 0;
  let cjk = 0;
  let images = 0;
  const eat = (s: string): void => {
    chars += s.length;
    cjk += countCjk(s);
  };

  for (const m of messages) {
    if (typeof m.content === "string") {
      eat(m.content ?? "");
    } else if (Array.isArray(m.content)) {
      // 多模态：text part 按原算法；image part 固定 800 tokens/图
      // （OpenAI detail:low 档量级；各服务端口径不一，粗估即可 —— PRD §5.5）
      for (const p of m.content) {
        if (p.type === "text") eat(p.text ?? "");
        else images += 1;
      }
    }
    for (const tc of m.tool_calls ?? []) {
      eat(tc.function.arguments);
      eat(tc.function.name);
    }
  }

  eat(JSON.stringify(tools));

  const ascii = Math.max(0, chars - cjk);
  return Math.ceil(ascii / 4 + cjk / 1.5) + messages.length * 4 + images * 800;
}

/**
 * 统计 CJK 字符数。
 *
 * 必须传字符串本身，不能传长度 —— 数字里没有 CJK，恒返回 0。
 * 覆盖范围按 code point 判定，含中日韩表意文字与假名音标。
 */
function countCjk(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // 0x3000-0x30FF：CJK 标点 / 假名；0x3400-0x9FFF：表意文字与兼容区
    // 0xF900-0xFAFF：兼容表意文字；0xFF00-0xFF60：全角字符
    if (
      (cp >= 0x3000 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60)
    ) {
      n++;
    }
  }
  return n;
}
