/**
 * 守卫：protocol 目录必须纯净、确定性、无外部依赖。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_SEMVER } from "../../src/protocol/index.ts";

const DIR = join(import.meta.dir, "..", "..", "src", "protocol");

describe("protocol 纯净性", () => {
  test("只允许内部相对 import", () => {
    for (const name of readdirSync(DIR).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(DIR, name), "utf8");
      for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
        expect(m[1]?.startsWith("./")).toBe(true);
      }
    }
  });

  test("禁止非确定性调用与平台 API", () => {
    for (const name of readdirSync(DIR).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(DIR, name), "utf8");
      expect(text).not.toContain("Date.now(");
      expect(text).not.toContain("Math.random(");
      expect(text).not.toContain("process.");
      expect(text).not.toContain("node:");
    }
  });

  test("v1.2 语义版本已冻结", () => {
    expect(PROTOCOL_SEMVER).toBe("1.2");
  });
});
