/**
 * tests/unit/path-policy.test.ts — v0.0.2 PathPolicy 的负样本矩阵（brief §2.1）。
 *
 * 直接对 `src/core/path.ts` 的 createPathPolicy 做单测（纯函数，不启进程）：
 *  - resolveRead：存在性 + realpath + 必须在 cwd 内；
 *  - resolveWrite：目标可不存在，但父目录 realpath 后仍必须在 cwd 内；
 *  - 负样本：`../../etc/passwd`、`/etc/passwd`、symlink 指向外部、symlink 目录逃逸、
 *    write 到不存在的父目录；
 *  - 正样本：cwd 内相对/绝对、cwd 内 symlink、`x/../y` 规范化后仍在 cwd。
 *
 * 模块未落地时整组 skip（探测后自动启用）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PATH_MODULE = join(import.meta.dir, "../../src/core/path.ts");
const available = existsSync(PATH_MODULE);
if (!available) console.warn("[unit/path-policy] src/core/path.ts 尚未落地：已跳过");

interface PathPolicy {
  resolveRead(p: string): string;
  resolveWrite(p: string): string;
}

type PolicyModule = {
  createPathPolicy(cwd: string): PathPolicy;
  PathDeniedError?: new (...args: any[]) => Error;
};

async function loadModule(): Promise<PolicyModule> {
  return (await import(PATH_MODULE)) as PolicyModule;
}

/** 期望抛错；返回错误对象便于断言类型/消息。 */
function throws(fn: () => unknown, label: string): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error(`期望抛错但成功返回：${label}`);
}

function expectDenied(policy: PathPolicy, op: "read" | "write", p: string, PathDeniedError?: PolicyModule["PathDeniedError"]): Error {
  const err = throws(() => (op === "read" ? policy.resolveRead(p) : policy.resolveWrite(p)), `${op}(${p})`);
  // 越界拒绝必须是可识别的 PathDeniedError；不同实现可能用 name 而非 instanceof。
  const deniedByType = PathDeniedError ? err instanceof PathDeniedError : false;
  const deniedByName = err.name === "PathDeniedError" || /PathDenied/i.test(err.message);
  expect(deniedByType || deniedByName, `${op}(${p}) 应抛 PathDeniedError，实际：${err.name}: ${err.message}`).toBe(true);
  return err;
}

describe.skipIf(!available)("PathPolicy", () => {
  let root = "";
  let cwd = "";
  let outside = "";
  const roots: string[] = [];

  async function setup(): Promise<PolicyModule> {
    root = await realpath(await mkdtemp(join(tmpdir(), "matrix-core-pathpolicy-")));
    roots.push(root);
    cwd = join(root, "cwd");
    outside = join(root, "outside");
    await mkdir(join(cwd, "sub"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(cwd, "inside.txt"), "inside", "utf8");
    await writeFile(join(cwd, "sub", "nested.txt"), "nested", "utf8");
    await writeFile(join(outside, "secret.txt"), "top-secret", "utf8");
    // symlink：一个指向 cwd 内（允许），两个指向 cwd 外（拒绝）。
    await symlink(join(cwd, "inside.txt"), join(cwd, "link-in.txt"));
    await symlink(join(outside, "secret.txt"), join(cwd, "link-out.txt"));
    await symlink(outside, join(cwd, "link-out-dir"));
    // simplify 回归：悬空 symlink（目标文件不存在）——write 不得借它逃逸。
    await symlink(join(outside, "ghost-target.txt"), join(cwd, "evil-dangling.txt"));
    return loadModule();
  }

  afterAll(async () => {
    for (const dir of roots) await rm(dir, { recursive: true, force: true });
  });

  test("正样本：cwd 内相对/绝对/规范化路径都能解析到 realpath", async () => {
    const mod = await setup();
    const policy = mod.createPathPolicy(cwd);

    const insideReal = await realpath(join(cwd, "inside.txt"));
    expect(policy.resolveRead("inside.txt")).toBe(insideReal);
    expect(policy.resolveRead("./sub/../inside.txt")).toBe(insideReal);
    expect(policy.resolveRead(join(cwd, "sub", "nested.txt"))).toBe(await realpath(join(cwd, "sub", "nested.txt")));
    // cwd 内 symlink 指向 cwd 内文件 → 允许（解析后仍在 cwd）。
    expect(policy.resolveRead("link-in.txt")).toBe(insideReal);
    // 写入：目标不存在但父目录存在 → 允许。
    expect(policy.resolveWrite("new.txt")).toBe(join(cwd, "new.txt"));
    // 父目录已存在（sub/）→ 允许。
    expect(policy.resolveWrite(join(cwd, "sub", "new-nested.txt"))).toBe(join(cwd, "sub", "new-nested.txt"));
  });

  test("负样本：`..` 逃逸与绝对外部路径被拒（read）", async () => {
    const mod = await setup();
    const policy = mod.createPathPolicy(cwd);
    expectDenied(policy, "read", "../../etc/passwd", mod.PathDeniedError);
    expectDenied(policy, "read", "../outside/secret.txt", mod.PathDeniedError);
    expectDenied(policy, "read", "/etc/passwd", mod.PathDeniedError);
    expectDenied(policy, "read", join(outside, "secret.txt"), mod.PathDeniedError);
  });

  test("负样本：symlink 指向 cwd 外 / symlink 目录逃逸被拒（read+write）", async () => {
    const mod = await setup();
    const policy = mod.createPathPolicy(cwd);
    expectDenied(policy, "read", "link-out.txt", mod.PathDeniedError);
    expectDenied(policy, "read", "link-out-dir/secret.txt", mod.PathDeniedError);
    // 写穿 symlink 目录同样必须拒绝（父目录 realpath 在 cwd 外）。
    expectDenied(policy, "write", "link-out-dir/pwned.txt", mod.PathDeniedError);
  });

  test("负样本：write 到不存在的父目录 / `..` 写逃逸被拒", async () => {
    const mod = await setup();
    const policy = mod.createPathPolicy(cwd);
    expectDenied(policy, "write", "no-such-dir/deep/file.txt", mod.PathDeniedError);
    expectDenied(policy, "write", "../escaped.txt", mod.PathDeniedError);
    expectDenied(policy, "write", join(outside, "escaped.txt"), mod.PathDeniedError);
    // 真正落盘校验：被拒的路径不应被创建。
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });

  test("回归：写悬空 symlink（目标不存在）与指向外部的已有 symlink 都必须拒绝", async () => {
    const mod = await setup();
    const policy = mod.createPathPolicy(cwd);
    // 目标文件不存在：旧实现只看父目录 realpath 会放行，必须在写入前拒绝。
    expectDenied(policy, "write", "evil-dangling.txt", mod.PathDeniedError);
    // 目标存在且在外部的 symlink 同样拒绝。
    expectDenied(policy, "write", "link-out.txt", mod.PathDeniedError);
    // 不得有任何目标被创建。
    expect(existsSync(join(outside, "ghost-target.txt"))).toBe(false);
    expect(existsSync(join(outside, "secret.txt"))).toBe(true); // 只读存在性，未写入
  });

  test("resolveRead 对不存在的 cwd 内文件抛错（存在性检查）", async () => {
    const mod = await setup();
    const policy = mod.createPathPolicy(cwd);
    const err = throws(() => policy.resolveRead("missing.txt"), "read(missing.txt)");
    expect(err).toBeInstanceOf(Error);
    expect(existsSync(join(cwd, "missing.txt"))).toBe(false);
  });
});
