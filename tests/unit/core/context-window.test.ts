/** K01a: pure behavior baseline adapted from neo-cli@029a040 context-window tests. */
import { expect, test } from "bun:test";
import { parseContextLimitFromError, isContextOverflowError, resolveContextWindow } from "../../../src/core/contextWindow.ts";

test("CW-B01 common context limits include k/m and commas", () => {
  expect(parseContextLimitFromError("This model's maximum context length is 128000 tokens")).toBe(128_000);
  expect(parseContextLimitFromError("context window is 200k tokens")).toBe(200_000);
  expect(parseContextLimitFromError("maximum context length: 131,072")).toBe(131_072);
  expect(parseContextLimitFromError("maximum context length is 1m tokens")).toBe(1_000_000);
});
test("CW-B02 max_tokens is not a context-window error", () => {
  expect(parseContextLimitFromError("max_tokens is 8192")).toBeNull();
  expect(isContextOverflowError({ message: "max_tokens is 8192", status: 400 })).toBe(false);
});
test("CW-B03 overflow classification respects HTTP status", () => {
  expect(isContextOverflowError({ message: "maximum context length is 128000 tokens", status: 400 })).toBe(true);
  expect(isContextOverflowError({ message: "prompt is too long: 300000 tokens", status: 400 })).toBe(true);
  expect(isContextOverflowError({ message: "context length exceeded", status: 400 })).toBe(true);
  expect(isContextOverflowError({ message: "maximum context length is 128000 tokens", status: 500 })).toBe(false);
  expect(isContextOverflowError({ message: "invalid api key", status: 401 })).toBe(false);
  expect(isContextOverflowError(null)).toBe(false);
});
test("CW-B04 env > config > known", () => {
  const env = { contextWindow: 128_000, source: "overflow_error" as const, updatedAt: "t" };
  expect(resolveContextWindow(512_000, "glm-5.3-flash", env)).toMatchObject({ tokens: 128_000, source: "overflow_error" });
  expect(resolveContextWindow(512_000, "glm-5.3-flash")).toEqual({ tokens: 512_000, source: "config" });
  expect(resolveContextWindow(0, "deepseek-v3").source).toBe("known");
});
test("CW-B05 known model remains known", () => {
  expect(resolveContextWindow(Number.NaN, "deepseek-chat", null)).toEqual({ tokens: 131_072, source: "known" });
});

test("CW-N01 unknown fallback must be default, not known", () => {
  const r = resolveContextWindow(Number.NaN, "no-such-model-xyz", null);
  expect(r.tokens).toBe(200_000);
  expect(r.source).toBe("default");
});
