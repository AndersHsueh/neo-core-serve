/**
 * core/path.ts — PathPolicy（v0.0.2 安全边界）。
 *
 * v0.0.1 的坑：neo 的 `insideCwd()` 定义了但从未被调用，read/write/edit/glob/list
 * 可以越出 cwd 读 `/etc/passwd`、也可以经 symlink 写到 cwd 之外。这里把「路径解析 +
 * 边界校验」收成一个可注入的纯对象，工具层只调用它，不再各自拼 `resolve`。
 *
 * 语义（与 docs/v0.0.2-brief.md §2.1 对齐）：
 *  - `resolveRead(p)`：存在性检查 + realpath（解析 symlink）+ 结果必须位于 cwd 内
 *    （或显式允许的外部根，如 `~/.neo/wiki`、`~/.neo/skills`、tool spill 目录）。
 *  - `resolveWrite(p)`：目标可以不存在；对**最近的已存在祖先**做 realpath 后校验，
 *    并逐级检查已存在的中间段（防止 cwd 内 symlink 目录把写入带出去）。
 *  - 越界/缺文件/悬空 symlink 一律 `throw PathDeniedError`（带 kind，便于工具层
 *    生成对模型友好的错误文案）。
 *
 * 已知窗口（v0.0.3 收）：resolveWrite 校验与实际写入之间目标可能被换成 symlink
 * （TOCTOU）；彻底修需要 O_NOFOLLOW + 以目录 fd 打开。v0.0.2 先保证「解析时点」正确。
 */

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Config } from "./config.ts";
import { toolTmpDir } from "./runtimeTmp.ts";

export type PathDenyKind = "outside" | "missing" | "symlink" | "invalid";

/** 路径被策略拒绝。`code` 与协议错误码对齐（forbidden）。 */
export class PathDeniedError extends Error {
  readonly code = "forbidden";
  constructor(
    message: string,
    readonly kind: PathDenyKind = "outside",
  ) {
    super(message);
    this.name = "PathDeniedError";
  }
}

export interface PathPolicyOptions {
  /**
   * 显式允许的外部根（用户级目录/临时目录）。按 **realpath** 后比较，
   * 因此 macOS 的 `/var → /private/var` 这类差异不会误拒。
   */
  allow?: string[];
}

export interface PathPolicy {
  /** cwd 的 realpath（作为边界基准）。 */
  readonly cwd: string;
  resolveRead(p: string): string;
  resolveWrite(p: string): string;
}

/* ------------------------------------------------------------------ */
/* 路径规范化                                                          */
/* ------------------------------------------------------------------ */

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 把一个可能还不存在的路径「规范化」：找到最近存在的祖先做 realpath，
 * 再把剩余未存在的段拼回去。用于把 allow 根对齐到真实路径。
 */
function canonicalizeMaybeMissing(p: string): string {
  const abs = resolve(p);
  const real = safeRealpath(abs);
  if (real) return real;
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    missing.unshift(cur.slice(parent.length).replace(/^[/\\]+/, ""));
    cur = parent;
    const curReal = safeRealpath(cur);
    if (curReal) return resolve(curReal, ...missing);
  }
}

function within(root: string, p: string): boolean {
  if (p === root) return true;
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */

export function createPathPolicy(cwd: string, opts: PathPolicyOptions = {}): PathPolicy {
  const base = resolve(cwd);
  const realCwd = safeRealpath(base) ?? base;
  const allowRoots = (opts.allow ?? [])
    .filter((r): r is string => typeof r === "string" && r.trim() !== "")
    .map((r) => (isAbsolute(r) ? canonicalizeMaybeMissing(r) : canonicalizeMaybeMissing(resolve(base, r))))
    // 去重、去掉被 cwd 覆盖的根（cwd 内不需要额外豁免）
    .filter((r) => !within(realCwd, r));

  const allowed = (real: string): boolean =>
    within(realCwd, real) || allowRoots.some((root) => within(root, real));

  const toAbs = (p: string): string => {
    if (typeof p !== "string" || p.trim() === "") {
      throw new PathDeniedError("路径不能为空", "invalid");
    }
    if (p.includes("\0")) throw new PathDeniedError("路径包含非法字符（NUL）", "invalid");
    return isAbsolute(p) ? resolve(p) : resolve(base, p);
  };

  return {
    cwd: realCwd,

    resolveRead(p: string): string {
      const abs = toAbs(p);
      if (!existsSync(abs)) throw new PathDeniedError(`文件不存在: ${abs}`, "missing");
      const real = safeRealpath(abs);
      if (!real) throw new PathDeniedError(`无法解析路径（悬空 symlink？）: ${abs}`, "symlink");
      if (!allowed(real)) {
        throw new PathDeniedError(`拒绝访问工作目录之外的路径: ${abs}（实际解析为 ${real}）`, "outside");
      }
      return real;
    },

    resolveWrite(p: string): string {
      const abs = toAbs(p);
      // 目标已存在：lstat 看本体；symlink（含悬空）一律解析真实目标后再判边界。
      // 不能用 existsSync：它跟随 symlink，悬空链接会被当成「不存在」而放行。
      let st: ReturnType<typeof lstatSync> | null = null;
      try {
        st = lstatSync(abs);
      } catch {
        st = null;
      }
      if (st) {
        const real = safeRealpath(abs);
        if (!real) throw new PathDeniedError(`无法解析路径（悬空 symlink？）: ${abs}`, "symlink");
        if (!allowed(real)) {
          throw new PathDeniedError(`拒绝写入工作目录之外的路径: ${abs}（实际解析为 ${real}）`, "outside");
        }
        if (st.isSymbolicLink()) {
          // 写入会跟随 symlink；返回真实目标，让上层（checkpoint/audit）看到 realpath。
          return real;
        }
        return abs;
      }
      // 目标不存在：父目录必须已存在（不替用户 mkdir -p 出深层路径），
      // 且父目录的 realpath 必须在边界内（防止经 cwd 内 symlink 目录逃逸）。
      const parent = dirname(abs);
      if (!existsSync(parent)) {
        throw new PathDeniedError(`父目录不存在: ${parent}`, "missing");
      }
      let parentStat;
      try {
        parentStat = statSync(parent);
      } catch {
        throw new PathDeniedError(`无法读取父目录: ${parent}`, "missing");
      }
      if (!parentStat.isDirectory()) {
        throw new PathDeniedError(`父路径不是目录: ${parent}`, "invalid");
      }
      const realParent = safeRealpath(parent);
      if (!realParent) {
        throw new PathDeniedError(`无法解析父目录（悬空 symlink？）: ${parent}`, "symlink");
      }
      if (!allowed(realParent)) {
        throw new PathDeniedError(
          `拒绝写入工作目录之外的路径: ${abs}（父目录解析为 ${realParent}）`,
          "outside",
        );
      }
      return abs;
    },
  };
}

/**
 * 由会话配置派生策略（工具层唯一入口）。
 *
 * 显式豁免（brief §2.1）：用户级记忆/wiki 目录、全局技能库、额外技能目录、
 * 工具输出 spill 目录。`shell` 工具完全不走 PathPolicy（它本来就能任意读写）。
 */
export function pathPolicyFor(cfg: Config): PathPolicy {
  const mem = cfg.memory;
  const allow: string[] = [];
  if (mem) {
    if (mem.userWikiDir) allow.push(mem.userWikiDir);
    if (mem.userLevelDir) allow.push(mem.userLevelDir);
    if (mem.journalDir) allow.push(mem.journalDir);
  }
  if (cfg.skillsStore) allow.push(cfg.skillsStore);
  for (const p of cfg.skillsExtraPaths ?? []) allow.push(p);
  try {
    allow.push(toolTmpDir());
  } catch {
    // 取不到 tmp 目录就不豁免（工具仍可在 cwd 内工作）
  }
  // 项目 wiki（<cwd>/.neo/wiki）本来就在 cwd 内；用户级 wiki 已在上面豁免。
  return createPathPolicy(cfg.cwd, { allow });
}
