#!/usr/bin/env python3
"""构建 @neo/core-compat 离线兼容归档（K01）。

产物：一个确定性 .tgz，内含唯一一个 compat 包：

    package/package.json
    package/index.js        bun build --format esm --minify 的产物（无依赖/无 sourcemap/无 TS）
    package/index.d.ts      公开 DTO 声明（无运行时代码）
    package/provenance.json 可复现记录（core 候选 SHA / 锁 / Bun / 构建参数）

设计约束（不要放宽）：
  * 输入**只从 git 取**：`git show <candidate>:<path>`，绝不读工作区文件。
    这样未提交改动、邻仓、用户设置都进不了包；构建器自身也必须已提交在
    candidate 里，否则拒绝构建（避免「未提交的构建器伪称 candidate」）。
  * 拒绝非精确 40 位 SHA、拒绝非 Bun 1.3.0。
  * 归档确定性：条目稳定排序、uid/gid=0、mtime=0、无主机路径/时钟/用户名；
    gzip 头 mtime=0、filename 为空、OS 字节固定。同样的输入 → 同样的字节。
  * provenance 只记「过去」：不嵌归档自身哈希，不记未来提交 SHA。

用法：
    python3 scripts/build-compat.py --candidate <40-hex> --bun <path/to/bun> --output dist/x.tgz
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

# ---- 固定契约 -------------------------------------------------------------

PACKAGE_NAME = "@neo/core-compat"
PACKAGE_VERSION = "0.0.0-k01"
ENGINES_BUN = ">=1.1.0"
REQUIRED_BUN_VERSION = "1.3.0"

# 打包入口：唯一实现，不复制算法。
ENTRY = "src/core/contextWindow.ts"
# 公开 DTO 声明（无运行时代码）。
DTS_SOURCE = "src/compat/v1.d.ts"
# 构建器自身：必须与 candidate 一致，否则拒绝构建。
BUILDER = "scripts/build-compat.py"
# 锁文件：只记哈希，不打包。
LOCKFILE = "bun.lock"

# 归档里允许出现的条目，顺序即写入顺序（稳定排序）。
ARCHIVE_ENTRIES = (
    "package/package.json",
    "package/index.js",
    "package/index.d.ts",
    "package/provenance.json",
)

# 构建参数：写进 provenance，也决定产物字节。
BUN_BUILD_ARGS = (
    "--format=esm",
    "--target=bun",
    "--minify",
    "--no-sourcemap",
)

# 产物里绝不能出现的源码/密钥痕迹（构建后自检）。
FORBIDDEN_IN_INDEX_JS = (
    ".ts",  # 源码路径/扩展名
    "sourceMappingURL",
    "import ",  # ESM import = 有依赖
    "require(",
    "process.env",
    "sk-",
    "api_key",
    "API_KEY",
)

SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class BuildError(RuntimeError):
    """构建前置条件不满足（拒绝构建，而不是产出可疑包）。"""


# ---- git 输入 -------------------------------------------------------------


def git(repo: Path, *args: str) -> bytes:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise BuildError(
            f"git {' '.join(args)} 失败（exit {proc.returncode}）："
            f"{proc.stderr.decode('utf-8', 'replace').strip()}"
        )
    return proc.stdout


def read_candidate_file(repo: Path, candidate: str, path: str) -> bytes:
    """只从 candidate 提交里读文件；不存在就拒绝。"""
    try:
        return git(repo, "show", f"{candidate}:{path}")
    except BuildError as exc:
        raise BuildError(f"candidate {candidate} 里没有 {path}：{exc}") from exc


def assert_builder_matches_candidate(repo: Path, candidate: str) -> None:
    """构建器自身必须与 candidate 逐字节一致（防止未提交构建器伪称 candidate）。"""
    committed = read_candidate_file(repo, candidate, BUILDER)
    # 用「本仓根下的构建器」而不是 __file__：测试会从别处调用同一份脚本，
    # 必须校验被构建的那个仓自己的构建器文件。
    actual = (repo / BUILDER).read_bytes()
    if committed != actual or committed != Path(__file__).read_bytes():
        raise BuildError(
            f"{BUILDER} 与 candidate {candidate[:12]} 不一致："
            "构建器改动必须先提交并固定为 candidate，再打包"
        )


def assert_candidate_exists(repo: Path, candidate: str) -> None:
    proc = subprocess.run(
        ["git", "-C", str(repo), "cat-file", "-e", f"{candidate}^{{commit}}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise BuildError(f"candidate 不是本仓的提交：{candidate}")


# ---- Bun ------------------------------------------------------------------


def resolve_bun(bun_arg: str) -> tuple[Path, str, str]:
    """返回 (路径, 版本, 二进制 sha256)。要求精确 Bun 1.3.0。"""
    path = Path(bun_arg).expanduser()
    if not path.is_absolute():
        found = shutil.which(bun_arg)
        if not found:
            raise BuildError(f"--bun 不是可执行文件：{bun_arg}")
        path = Path(found).resolve()
    if not path.is_file():
        raise BuildError(f"--bun 不是可执行文件：{bun_arg}")
    proc = subprocess.run(
        [str(path), "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )
    if proc.returncode != 0:
        raise BuildError(f"{path} --version 失败（exit {proc.returncode}）")
    version = proc.stdout.decode("utf-8", "replace").strip()
    if version != REQUIRED_BUN_VERSION:
        raise BuildError(
            f"要求 Bun {REQUIRED_BUN_VERSION}，实际 {version}（{path}）"
        )
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    return path, version, sha


# ---- 构建 -----------------------------------------------------------------


def run_bun_build(bun: Path, workdir: Path) -> bytes:
    """在临时目录里用 bun build 把入口打成 minified ESM。"""
    outfile = workdir / "index.js"
    cmd = [
        str(bun),
        "build",
        str(workdir / Path(ENTRY).name),
        f"--outfile={outfile}",
        *BUN_BUILD_ARGS,
    ]
    proc = subprocess.run(
        cmd, cwd=str(workdir), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )
    if proc.returncode != 0:
        raise BuildError(
            f"bun build 失败（exit {proc.returncode}）："
            f"{proc.stderr.decode('utf-8', 'replace').strip()}"
        )
    if not outfile.is_file():
        raise BuildError("bun build 没有产出 index.js")
    return outfile.read_bytes()


def assert_clean_bundle(js: bytes) -> None:
    text = js.decode("utf-8", "replace")
    for needle in FORBIDDEN_IN_INDEX_JS:
        if needle in text:
            raise BuildError(f"产物 index.js 含禁止内容 {needle!r}（源码/依赖/密钥泄漏）")


def package_manifest() -> dict:
    return {
        "name": PACKAGE_NAME,
        "version": PACKAGE_VERSION,
        "private": True,
        "type": "module",
        "engines": {"bun": ENGINES_BUN},
        "exports": {
            "./compat/v1": {
                "types": "./index.d.ts",
                "import": "./index.js",
            }
        },
    }


def provenance_doc(
    *,
    candidate: str,
    lock_sha: str,
    bun_version: str,
    bun_sha: str,
    entry_sha: str,
    dts_sha: str,
    index_js_sha: str,
    package_json_sha: str,
) -> dict:
    """只记过去：候选 SHA、锁、Bun、构建参数与产物哈希；不记归档自身/未来提交。"""
    return {
        "schema": "neo-core-compat/provenance@1",
        "package": {"name": PACKAGE_NAME, "version": PACKAGE_VERSION},
        "core": {
            "candidate": candidate,
            "entry": ENTRY,
            "entrySha256": entry_sha,
            "dts": DTS_SOURCE,
            "dtsSha256": dts_sha,
            "lockfile": LOCKFILE,
            "lockfileSha256": lock_sha,
            "builder": BUILDER,
        },
        "bun": {
            "version": bun_version,
            "binarySha256": bun_sha,
            "buildArgs": list(BUN_BUILD_ARGS),
        },
        "outputs": {
            "index.js": index_js_sha,
            "package.json": package_json_sha,
        },
        "archive": {
            "entries": list(ARCHIVE_ENTRIES),
            "deterministic": {
                "sort": "path-ascending",
                "uid": 0,
                "gid": 0,
                "mtime": 0,
                "gzipMtime": 0,
                "gzipFilename": "",
            },
        },
    }


# ---- 确定性 tar.gz --------------------------------------------------------


def _tarinfo(name: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mode = 0o644
    info.type = tarfile.REGTYPE
    return info


def build_tgz(files: dict[str, bytes]) -> bytes:
    """稳定排序 + 归零元数据 + gzip 头归零 → 字节可复现。"""
    missing = [n for n in ARCHIVE_ENTRIES if n not in files]
    extra = [n for n in files if n not in ARCHIVE_ENTRIES]
    if missing or extra:
        raise BuildError(f"归档条目不符：缺 {missing}，多 {extra}")

    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tar:
        for name in sorted(files, key=lambda n: n.encode("utf-8")):
            data = files[name]
            tar.addfile(_tarinfo(name, len(data)), io.BytesIO(data))

    gz = io.BytesIO()
    # mtime=0 + filename="" → 头里没有时钟也没有主机路径。
    with gzip.GzipFile(filename="", mode="wb", fileobj=gz, mtime=0, compresslevel=9) as f:
        f.write(raw.getvalue())
    data = bytearray(gz.getvalue())
    # 固定 OS 字节（255 = unknown），否则不同平台 gzip 头不同。
    if len(data) >= 10:
        data[9] = 255
    return bytes(data)


# ---- 主流程 ---------------------------------------------------------------


def build(candidate: str, bun_arg: str, output: Path, repo: Path) -> dict:
    if not SHA_RE.match(candidate):
        raise BuildError(f"--candidate 必须是精确 40 位小写 SHA，收到 {candidate!r}")

    assert_candidate_exists(repo, candidate)
    # 构建器必须先与 candidate 一致，再谈 Bun：否则「未提交构建器」会以
    # 版本不符为借口混过去，看起来像拒绝、实际没验真源。
    assert_builder_matches_candidate(repo, candidate)

    bun_path, bun_version, bun_sha = resolve_bun(bun_arg)

    entry_bytes = read_candidate_file(repo, candidate, ENTRY)
    dts_bytes = read_candidate_file(repo, candidate, DTS_SOURCE)
    lock_bytes = read_candidate_file(repo, candidate, LOCKFILE)

    with tempfile.TemporaryDirectory(prefix="neo-compat-") as tmp:
        workdir = Path(tmp)
        (workdir / Path(ENTRY).name).write_bytes(entry_bytes)
        index_js = run_bun_build(bun_path, workdir)

    assert_clean_bundle(index_js)

    package_json = (json.dumps(package_manifest(), indent=2, sort_keys=True) + "\n").encode()
    provenance = provenance_doc(
        candidate=candidate,
        lock_sha=hashlib.sha256(lock_bytes).hexdigest(),
        bun_version=bun_version,
        bun_sha=bun_sha,
        entry_sha=hashlib.sha256(entry_bytes).hexdigest(),
        dts_sha=hashlib.sha256(dts_bytes).hexdigest(),
        index_js_sha=hashlib.sha256(index_js).hexdigest(),
        package_json_sha=hashlib.sha256(package_json).hexdigest(),
    )
    provenance_bytes = (json.dumps(provenance, indent=2, sort_keys=True) + "\n").encode()

    files = {
        "package/package.json": package_json,
        "package/index.js": index_js,
        "package/index.d.ts": dts_bytes,
        "package/provenance.json": provenance_bytes,
    }
    tgz = build_tgz(files)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(tgz)
    return {
        "output": str(output),
        "bytes": len(tgz),
        "sha256": hashlib.sha256(tgz).hexdigest(),
        "candidate": candidate,
        "bun": bun_version,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="构建 @neo/core-compat 离线兼容归档（确定性 tgz）"
    )
    parser.add_argument("--candidate", required=True, help="core 仓精确 40 位提交 SHA")
    parser.add_argument("--bun", required=True, help="精确 Bun 1.3.0 可执行文件路径")
    parser.add_argument("--output", required=True, help="输出 .tgz 路径（建议 dist/ 下）")
    parser.add_argument(
        "--repo",
        default=str(Path(__file__).resolve().parent.parent),
        help="core 仓根（默认本脚本所在仓；测试可指向别处）",
    )
    args = parser.parse_args(argv)

    try:
        result = build(
            candidate=args.candidate,
            bun_arg=args.bun,
            output=Path(args.output),
            repo=Path(args.repo).resolve(),
        )
    except BuildError as exc:
        print(f"build-compat: REFUSED: {exc}", file=sys.stderr)
        return 2

    print(
        f"build-compat: {result['output']} "
        f"({result['bytes']} bytes, sha256={result['sha256']}) "
        f"candidate={result['candidate'][:12]} bun={result['bun']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
