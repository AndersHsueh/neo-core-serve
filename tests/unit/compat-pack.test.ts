/**
 * K01 compat 打包契约测试。
 *
 * 两层：
 *  1. 结构测试（永远跑）：脚本/声明/清单契约在不在、对不对，不依赖 candidate。
 *  2. 行为测试（需要已提交 candidate）：在临时 git 仓里造一个「已提交」的
 *     candidate，实调 scripts/build-compat.py 打包到临时目录，验归档内容、
 *     确定性、拒绝路径、以及公开 DTO 与 core 实现的双向类型兼容。
 *
 * 为什么行为测试要造临时仓：真实 candidate 由编排者固定，本测试不能假设
 * 工作区提交状态；但打包逻辑本身必须被真跑过，不能只测结构。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "build-compat.py");
const DTS = join(ROOT, "src", "compat", "v1.d.ts");
const ENTRY = join(ROOT, "src", "core", "contextWindow.ts");

const BUN = process.env.NEO_COMPAT_BUILD_BUN ?? process.execPath; // pinned builder may differ from the runtime under test
const BUN_VERSION = execFileSync(BUN, ["--version"], { encoding: "utf8" }).trim();

const TMP_DIRS: string[] = [];
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

/* ------------------------------------------------------------------ *
 * 1. 结构契约（不依赖 candidate）
 * ------------------------------------------------------------------ */

describe("compat pack · 结构契约", () => {
  test("构建器与声明文件存在", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(existsSync(DTS)).toBe(true);
  });

  test("构建器只用 Python 标准库（无第三方 import）", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const imports = [...src.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1] ?? "");
    expect(imports.length).toBeGreaterThan(0);
    // 允许的只有标准库；出现点号包名（第三方）或已知第三方名即失败。
    const stdlib = new Set([
      "argparse", "gzip", "hashlib", "io", "json", "re", "shutil", "subprocess",
      "sys", "tarfile", "tempfile", "pathlib", "__future__",
    ]);
    for (const name of imports) expect(stdlib.has(name.split(".")[0] ?? "")).toBe(true);
  });

  test("归档条目白名单固定为 4 项，且不含源码/图/密钥", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const block = /ARCHIVE_ENTRIES = \(([\s\S]*?)\)/.exec(src)?.[1] ?? "";
    const entries = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(entries).toEqual([
      "package/package.json",
      "package/index.js",
      "package/index.d.ts",
      "package/provenance.json",
    ]);
  });

  test("构建器拒绝非精确 SHA、非 Bun 1.3.0，并强制构建器与 candidate 一致", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("REQUIRED_BUN_VERSION = \"1.3.0\"");
    expect(src).toMatch(/SHA_RE = re\.compile\(r"\^\[0-9a-f\]\{40\}\$"\)/);
    expect(src).toContain("assert_builder_matches_candidate");
    expect(src).toContain("--no-sourcemap");
    expect(src).toContain("--minify");
  });

  test("公开 DTO 只声明 4 函数 + 3 类型，且无运行时代码", () => {
    const src = readFileSync(DTS, "utf8");
    // 去掉块注释与行注释后，只应剩 declare / interface / type 三种语句。
    // 接口/函数体内的成员行（`x: T;`、`) : T;`）属于声明的一部分，不算可执行语句；
    // 真正的判据是：没有任何 import/赋值/调用/类/语句关键字。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/\bimport\b|\bclass\b|\bconst\b|\blet\b|\bvar\b|\bfunction\s+\w+\s*\([^)]*\)\s*\{/);
    // 无赋值语句（`export type X = ...` 的类型别名除外）。
    expect(code).not.toMatch(/^(?!export\s+type\b).*=/m);
    expect(code).not.toMatch(/\breturn\b|\bif\s*\(/); // 无语句
    const fns = [...src.matchAll(/export declare function (\w+)/g)].map((m) => m[1]);
    expect(fns.sort()).toEqual([
      "isContextOverflowError",
      "knownWindow",
      "parseContextLimitFromError",
      "resolveContextWindow",
    ]);
    const types = [...src.matchAll(/export (?:type|interface) (\w+)/g)].map((m) => m[1]);
    expect(types.sort()).toEqual(["ContextWindowEnv", "ResolvedWindow", "WindowSource"]);
    expect(src).not.toMatch(/\bimport\b/);
  });

  test("core 实现导出的公开符号与声明一致（唯一实现，不复制算法）", async () => {
    const mod = await import(ENTRY);
    expect(Object.keys(mod).sort()).toEqual([
      "isContextOverflowError",
      "knownWindow",
      "parseContextLimitFromError",
      "resolveContextWindow",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 行为契约（临时 git 仓里造 candidate，实调打包）
 * ------------------------------------------------------------------ */

/** 造一个最小 core 仓：只含打包需要的 4 个输入文件，并提交成 candidate。 */
function makeCandidateRepo(): { repo: string; candidate: string } {
  const repo = tmp("neo-compat-repo-");
  const files: Record<string, string> = {
    "scripts/build-compat.py": readFileSync(SCRIPT, "utf8"),
    "src/core/contextWindow.ts": readFileSync(ENTRY, "utf8"),
    "src/compat/v1.d.ts": readFileSync(DTS, "utf8"),
    "bun.lock": readFileSync(join(ROOT, "bun.lock"), "utf8"),
  };
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  }
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", "-A");
  git(
    "-c", "user.name=compat-test",
    "-c", "user.email=compat-test@example.invalid",
    "commit", "-q", "-m", "candidate",
  );
  return { repo, candidate: git("rev-parse", "HEAD") };
}

const runPack = (args: string[]): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync("python3", [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** 读 tgz 里的条目（用 python 标准库，避免测试引入 tar 依赖）。 */
interface ArchiveContents {
  entries: Record<string, string>;
  meta: Array<[string, number, number, number, string, string, number]>;
}
const readArchive = (tgz: string): ArchiveContents => {
  const py = [
    "import tarfile,json,sys",
    "t=tarfile.open(sys.argv[1],'r:gz')",
    "out={}",
    "for m in t.getmembers():",
    "    assert m.isfile(), m.name",
    "    out[m.name]=t.extractfile(m).read().decode('utf-8')",
    "print(json.dumps({'entries':out,'meta':[[m.name,m.uid,m.gid,m.mtime,m.uname,m.gname,m.mode] for m in t.getmembers()]}))",
  ].join("\n");
  const r = spawnSync("python3", ["-c", py, tgz], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as ArchiveContents;
};

describe("compat pack · 行为契约", () => {
  const { repo, candidate } = makeCandidateRepo();
  const outDir = tmp("neo-compat-out-");

  test("拒绝非精确 SHA / 不存在的 candidate", () => {
    const short = runPack(["--candidate", candidate.slice(0, 12), "--bun", BUN, "--output", join(outDir, "a.tgz"), "--repo", repo]);
    expect(short.code).toBe(2);
    expect(short.stderr).toContain("40 位");
    const missing = runPack(["--candidate", "0".repeat(40), "--bun", BUN, "--output", join(outDir, "b.tgz"), "--repo", repo]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("candidate");
  });

  test("拒绝非 Bun 1.3.0", () => {
    const fakeBun = join(outDir, "wrong-version-bun");
    writeFileSync(fakeBun, "#!/bin/sh\nprintf '1.1.0\\n'\n");
    chmodSync(fakeBun, 0o755);
    const r = runPack(["--candidate", candidate, "--bun", fakeBun, "--output", join(outDir, "c.tgz"), "--repo", repo]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("1.3.0");
  });

  test("拒绝构建器与 candidate 不一致（未提交构建器不能伪称 candidate）", () => {
    // 在临时仓里改构建器但不提交 → 磁盘版本与 candidate 不一致。
    // 该检查发生在 Bun 版本检查之前，所以本机 Bun 不是 1.3.0 也能验到。
    const builder = join(repo, "scripts", "build-compat.py");
    const original = readFileSync(builder, "utf8");
    writeFileSync(builder, `${original}\n# local edit\n`);
    try {
      const r = runPack(["--candidate", candidate, "--bun", BUN, "--output", join(outDir, "d.tgz"), "--repo", repo]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("不一致");
    } finally {
      writeFileSync(builder, original);
    }
  });

  test.skipIf(BUN_VERSION !== "1.3.0")("K01 executed builder must match candidate, not only repo copy", () => {
    const runner = join(outDir, "altered-builder.py");
    writeFileSync(runner, readFileSync(SCRIPT, "utf8") + "\n# altered running builder\n");
    const r = spawnSync("python3", [runner, "--candidate", candidate, "--bun", BUN, "--output", join(outDir, "tampered.tgz"), "--repo", repo], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("不一致");
  });

  test.skipIf(BUN_VERSION !== "1.3.0")("真实打包：4 条目、清单契约、无源码/依赖/sourcemap（需Bun1.3.0）", () => {
    const out = join(outDir, "e.tgz");
    const r = runPack(["--candidate", candidate, "--bun", BUN, "--output", out, "--repo", repo]);
    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(true);

    const archive = readArchive(out);
    expect(Object.keys(archive.entries).sort()).toEqual([
      "package/index.d.ts",
      "package/index.js",
      "package/package.json",
      "package/provenance.json",
    ]);

    const pkg = JSON.parse(archive.entries["package/package.json"] ?? "{}");
    expect(pkg).toMatchObject({
      name: "@neo/core-compat",
      version: "0.0.0-k01",
      private: true,
      type: "module",
      engines: { bun: ">=1.1.0" },
      exports: { "./compat/v1": { types: "./index.d.ts", import: "./index.js" } },
    });
    expect(Object.keys(pkg.exports)).toEqual(["./compat/v1"]);

    const js = archive.entries["package/index.js"] ?? "";
    expect(js).not.toContain("sourceMappingURL");
    expect(js).not.toMatch(/^\s*import\s/m);
    expect(js).not.toContain("require(");
    expect(js).not.toContain(".ts");
    expect(js).toContain("resolveContextWindow");

    // 确定性元数据：uid/gid/mtime 归零、无用户名。
    for (const [, uid, gid, mtime, uname, gname] of archive.meta) {
      expect([uid, gid, mtime, uname, gname]).toEqual([0, 0, 0, "", ""]);
    }

    // provenance 只记过去：候选 SHA、锁哈希、Bun、构建参数；不含归档自身哈希。
    const prov = JSON.parse(archive.entries["package/provenance.json"] ?? "{}");
    expect(prov.core.candidate).toBe(candidate);
    expect(prov.core.lockfileSha256).toBe(sha256(readFileSync(join(ROOT, "bun.lock"))));
    expect(prov.bun.version).toBe("1.3.0");
    expect(prov.bun.buildArgs).toContain("--minify");
    expect(JSON.stringify(prov)).not.toContain(sha256(readFileSync(out)));

    // 二次构建字节一致。
    const out2 = join(outDir, "e2.tgz");
    expect(runPack(["--candidate", candidate, "--bun", BUN, "--output", out2, "--repo", repo]).code).toBe(0);
    expect(sha256(readFileSync(out2))).toBe(sha256(readFileSync(out)));

    // 产物可被真实 import，且行为与 core 一致。
    const extract = join(outDir, "extract");
    mkdirSync(extract, { recursive: true });
    execFileSync("python3", ["-c", "import tarfile,sys;tarfile.open(sys.argv[1]).extractall(sys.argv[2],filter='data')", out, extract]);
    const script = join(outDir, "probe.mjs");
    writeFileSync(
      script,
      [
        `import * as m from ${JSON.stringify(join(extract, "package", "index.js"))};`,
        "const env = { contextWindow: 128000, source: 'overflow_error', updatedAt: 't' };",
        "const r = m.resolveContextWindow(512000, 'glm-5.3-flash', env);",
        "console.log(JSON.stringify({",
        "  keys: Object.keys(m).sort(),",
        "  identity: r.env === env,",
        "  r,",
        "  unknown: m.resolveContextWindow(NaN, 'no-such-model-xyz', null),",
        "  limit: m.parseContextLimitFromError('maximum context length is 128000 tokens'),",
        "  overflow: m.isContextOverflowError({ message: 'context length exceeded', status: 400 }),",
        "}));",
      ].join("\n"),
    );
    const probe = JSON.parse(execFileSync(BUN, [script], { encoding: "utf8" }));
    expect(probe.keys).toEqual([
      "isContextOverflowError",
      "knownWindow",
      "parseContextLimitFromError",
      "resolveContextWindow",
    ]);
    expect(probe.identity).toBe(true);
    expect(probe.r).toMatchObject({ tokens: 128_000, source: "overflow_error" });
    expect(probe.unknown).toEqual({ tokens: 200_000, source: "default" });
    expect(probe.limit).toBe(128_000);
    expect(probe.overflow).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 公开 DTO 与 core 实现的双向类型兼容（tsc 实检）
 * ------------------------------------------------------------------ */

describe("compat pack · 类型兼容", () => {
  test("v1.d.ts 与 core 实现双向可赋值（tsc --noEmit 通过）", () => {
    const dir = tmp("neo-compat-types-");
    const core = join(ROOT, "src", "core", "contextWindow.ts");
    const dts = join(ROOT, "src", "compat", "v1.d.ts");
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      [
        `import * as core from ${JSON.stringify(core)};`,
        `import type * as v1 from ${JSON.stringify(dts)};`,
        "import type { ModelContextInfo } from " +
          JSON.stringify(join(ROOT, "src", "core", "env", "types.ts")) +
          ";",
        "",
        "// 1) 函数签名双向可赋值",
        "const a: typeof v1.resolveContextWindow = core.resolveContextWindow;",
        "const b: typeof core.resolveContextWindow = null as unknown as typeof v1.resolveContextWindow;",
        "const c: typeof v1.knownWindow = core.knownWindow;",
        "const d: typeof v1.isContextOverflowError = core.isContextOverflowError;",
        "const e: typeof v1.parseContextLimitFromError = core.parseContextLimitFromError;",
        "",
        "// 2) 类型双向可赋值",
        "const src: v1.WindowSource = null as unknown as core.WindowSource;",
        "const back: core.WindowSource = null as unknown as v1.WindowSource;",
        "const rw: v1.ResolvedWindow = null as unknown as core.ResolvedWindow;",
        "const rwBack: core.ResolvedWindow = null as unknown as v1.ResolvedWindow;",
        "",
        "// 3) core 的真实 env 记录可直接传给 compat 函数（结构兼容）",
        "declare const info: ModelContextInfo;",
        "const resolved = core.resolveContextWindow(0, 'm', info);",
        "const viaCompat: v1.ResolvedWindow = resolved;",
        "// 4) 返回 env 保持 identity（同一对象）",
        "const same: ModelContextInfo | undefined = resolved.env;",
        "",
        "export const _check = [a, b, c, d, e, src, back, rw, rwBack, viaCompat, same];",
      ].join("\n"),
    );
    const tsconfig = join(dir, "tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          lib: ["ESNext"],
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          types: ["bun"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          typeRoots: [join(ROOT, "node_modules", "@types")],
        },
        include: [probe],
      }),
    );
    const r = spawnSync(BUN, ["x", "tsc", "-p", tsconfig], { encoding: "utf8", cwd: ROOT });
    expect((r.stdout ?? "") + (r.stderr ?? "")).toBe("");
    expect(r.status).toBe(0);
  });
});
