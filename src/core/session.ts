/**
 * 会话持久化。
 * 每次完整对话落盘到 ~/.neo/sessions/<ts>-<id>.json，支持 --resume 恢复。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ContentPart, Message } from "./llm.ts";
import type { LastTurnMeta } from "./turnDiagnostics.ts";
import { attachmentsDir, sessionsDir } from "./paths.ts";

/** 解码后的图片附件（data URL → 文件）。 */
export interface ImageFile {
  filename: string;
  mime: string;
  bytes: Buffer;
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * data URL → 落盘文件名（内容哈希命名）。
 *
 * 为什么用哈希而不是 `img-<partIndex>`：part index 每个用户消息都从 0/1 开始，
 * 多轮发图会互相覆盖（v0.0.1 的坑）。内容哈希天然去重且不撞名。
 */
export function decodeImageDataUrl(url: string): ImageFile | null {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(url);
  if (!m) return null;
  const mime = (m[1] ?? "image/png").toLowerCase();
  const b64 = m[2] ?? "";
  const bytes = Buffer.from(b64, "base64");
  const ext = IMAGE_EXT[mime] ?? "png";
  const hash = createHash("sha256").update(b64).digest("hex").slice(0, 16);
  return { filename: `img-${hash}.${ext}`, mime, bytes };
}

/** 把一张 data URL 图片写到 `<sessions>/attachments/<id>/`，返回相对 ref（不含 sessions 前缀）。 */
export function writeImageAttachment(sessionId: string, file: ImageFile): string {
  const dir = attachmentsDir(sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const abs = join(dir, file.filename);
  if (!existsSync(abs)) writeFileSync(abs, file.bytes, { mode: 0o600 });
  return `attachments/${sessionId}/${file.filename}`;
}

export interface SessionMeta {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  cwd: string;
  turns: number;
  /**
   * 最后一轮的诊断摘要（v0.4.1 A1）。旧会话没有该字段 = 正常。
   * 仅用于 resume 告警与 /sessions 标记，不参与消息恢复。
   */
  lastTurn?: LastTurnMeta;
}

export interface SessionFile {
  version: 1;
  meta: SessionMeta;
  messages: Message[];
}

function ensureDir(): string {
  const d = sessionsDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function createSession(model: string, cwd: string): { meta: SessionMeta; save: () => void } {
  const dir = ensureDir();
  const id = `${stamp()}-${shortId()}`;
  const path = join(dir, `${id}.json`);
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id,
    path,
    createdAt: now,
    updatedAt: now,
    model,
    cwd,
    turns: 0,
  };
  const data: SessionFile = { version: 1, meta, messages: [] };

  return {
    meta,
    save: () => {
      meta.updatedAt = new Date().toISOString();
      data.meta = meta;
      writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
    },
  };
}

/**
 * 接管已有会话文件（--resume 真续接）：沿用原 id / path / createdAt，不新建文件。
 * cwd 保留会话原始记录（便于提示“原目录”），model 用当前配置。
 */
export function adoptSession(meta: SessionMeta, model: string): { meta: SessionMeta } {
  return {
    meta: {
      ...meta,
      model,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function listSessions(limit = 20): SessionMeta[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
  const metas: SessionMeta[] = [];
  for (const p of files) {
    try {
      const st = statSync(p);
      const raw = JSON.parse(readFileSync(p, "utf8")) as SessionFile;
      if (raw.meta) metas.push({ ...raw.meta, path: p, updatedAt: st.mtime.toISOString() });
    } catch {
      // 损坏的会话文件跳过
    }
  }
  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return metas.slice(0, limit);
}

export function loadSession(id: string): SessionFile | null {
  const dir = sessionsDir();
  if (!existsSync(dir)) return null;
  // 先精确匹配文件名（<id>.json），再退回包含匹配：避免 /export 2026 静默导错会话。
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const exact = files.find((f) => f === `${id}.json`);
  const candidates = exact ? [exact] : files.filter((f) => f.includes(id));
  if (candidates.length === 0) return null;
  try {
    const f = JSON.parse(readFileSync(join(dir, candidates[0] as string), "utf8")) as SessionFile;
    // M2（PRD §5.6）：出口统一 hydrate —— $ref 重组回 data URL，附件缺失降级为占位文本
    return { ...f, messages: hydrateMessages(f.messages) };
  } catch {
    return null;
  }
}

export function applyRestored(system: Message | undefined, restored: Message[]): Message[] {
  const sys = system?.role === "system" ? system : null;
  return [...(sys ? [sys] : []), ...restored.filter((m) => m.role !== "system")];
}

export function saveSession(messages: Message[], meta: SessionMeta): void {
  ensureDir();
  meta.updatedAt = new Date().toISOString();
  // 图片 data URL 不进会话 JSON（一张截图 1~3MB base64），落盘到
  // attachments/<sessionId>/，JSON 里存 $ref 指针；恢复时按 mime 重组。
  // v0.0.2：支持 png/jpeg/webp（扩展名与 mime 一起记，hydrate 才不会把 jpeg 标成 png）。
  const dir = attachmentsDir(meta.id);
  if (messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"))) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const serialized = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts: (ContentPart | { type: "image_ref"; ref: string; mime: string })[] = m.content.map((p) => {
      if (p.type !== "image_url") return p;
      const file = decodeImageDataUrl(p.image_url.url);
      if (!file) return p; // 非 data URL（自定义 URL）原样保留
      const ref = writeImageAttachment(meta.id, file);
      return { type: "image_ref", ref, mime: file.mime };
    });
    return { ...m, content: parts };
  });
  const data: SessionFile = { version: 1, meta, messages: serialized as Message[] };
  writeFileSync(meta.path, JSON.stringify(data, null, 2), "utf8");
}

/** 恢复时把 $ref 重组回 data URL；附件文件缺失 → text part「[Image #N 已丢失]」，不阻塞。 */
export function hydrateMessages(messages: Message[]): Message[] {
  const dir = sessionsDir();
  let imgSeq = 0;
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const parts: ContentPart[] = m.content.map((p) => {
      const ref = (p as { type?: string; ref?: string }).ref;
      if ((p as { type?: string }).type !== "image_ref" || !ref) return p as ContentPart;
      const file = join(dir, ref);
      if (!existsSync(file)) {
        imgSeq += 1;
        return { type: "text", text: `[Image #${imgSeq} 已丢失]` };
      }
      const mime = (p as { mime?: string }).mime ?? mimeForRef(ref);
      const b64 = readFileSync(file).toString("base64");
      return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
    });
    return { ...m, content: parts };
  });
}

/** 老会话（无 mime 字段）按扩展名推断；未知扩展名回落 png（v0.0.1 行为）。 */
function mimeForRef(ref: string): string {
  const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}


/** 持久化前确保附件目录存在（saveSession 内部调用）。 */
export function ensureAttachmentsDir(sessionId: string): string {
  const d = attachmentsDir(sessionId);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** 附件绝对路径（host 发图时与 saveSession 用同一套布局）。 */
export function attachmentPath(sessionId: string, filename: string): string {
  return join(attachmentsDir(sessionId), filename);
}

