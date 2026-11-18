/**
 * K45b：跨包 LLM 错误形状必须被纯叶识别，不能只认本仓 instanceof。
 */
import { describe, expect, test } from "bun:test";
import { LLMError, LLMTimeoutError } from "../../../src/core/llm/types.ts";
import {
  isParallelToolCallsRejection,
  parseMaxTokensLimit,
  shouldDowngradeForOpaque400,
} from "../../../src/core/llm/maxTokensClassify.ts";
import { attributeFailure } from "../../../src/core/modelFallbackAttr.ts";

describe("compat leaf · foreign LLMError shape", () => {
  test("parseMaxTokensLimit accepts a same-name foreign error", () => {
    const local = new LLMError("max_tokens: 100000 > 64000, which is the maximum allowed", 400);
    const foreign = { name: "LLMError", message: local.message, status: 400, body: undefined as string | undefined };
    expect(parseMaxTokensLimit(local, 100000)).toBe(64000);
    expect(parseMaxTokensLimit(foreign, 100000)).toBe(64000);
    expect(parseMaxTokensLimit({ name: "Error", message: local.message, status: 400 }, 100000)).toBeNull();
  });

  test("shouldDowngradeForOpaque400 and parallel rejection use the same shape", () => {
    const opaque = { name: "LLMError", message: "request was rejected by an internal MaaS component", status: 400 };
    expect(shouldDowngradeForOpaque400(opaque, 512000)).toBe(true);
    expect(shouldDowngradeForOpaque400(new LLMError(opaque.message, 400), 512000)).toBe(true);
    const parallel = {
      name: "LLMError",
      message: "unknown field: parallel_tool_calls",
      status: 400,
    };
    expect(isParallelToolCallsRejection(parallel)).toBe(true);
    expect(shouldDowngradeForOpaque400(parallel, 512000)).toBe(false);
  });

  test("attributeFailure keeps status from a foreign LLMError", () => {
    const foreign = { name: "LLMError", message: "too many requests", status: 429 };
    expect(attributeFailure(foreign, false)).toMatchObject({ code: "rate_limit" });
    // 若只按 message 重建、丢掉 status，429 会被错判成 network。
    expect(attributeFailure(new LLMError("too many requests", 429), false)?.code).toBe("rate_limit");
    const timeout = { name: "LLMTimeoutError", message: "idle wait", status: undefined };
    expect(attributeFailure(timeout, false)?.code).toBe("timeout");
    expect(attributeFailure(new LLMTimeoutError("idle", 1000), false)?.code).toBe("timeout");
  });
});
