// dsh-group-rules-prompt
// 把群规则从「每轮重拼进用户消息正文的群公告」搬到「系统提示词的一个 section」：
// 只注入一次、进前缀缓存、不随轮次累积。零侵入：不改 ds-bot、不改 notice、可整插件卸载回滚。
//
// 注入机制照 dsh-free-search/lib/index.js:4149-4163 的先例：
//   ctx.inject(['systemPrompt'], (sctx) => sctx.systemPrompt.section({ name, order, interpolate:false, text }))
// section 顺序 645 紧跟 ds-bot 的 bot-identity（640，见 ds-bot/src/host/prompt.js:67-72）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-group-rules-prompt';
export const inject = ['systemPrompt'];

export const SECTION_NAME = 'group-rules';
export const SECTION_ORDER = 645;
export const PLUGIN_NAME = 'dsh-group-rules-prompt';

export const DEFAULTS = Object.freeze({
  enabled: true,
  defaultFile: '',
  fileByRoom: Object.freeze({}),
  maxChars: 20000,
  refreshMs: 2000,
});

// ---------------------------------------------------------------- 只 warn 一次
const warned = new Set();

export function resetWarnings() {
  warned.clear();
}

function warnOnce(logger, key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  const sink = typeof logger?.warn === 'function' ? logger : console;
  try {
    sink.warn(`[${PLUGIN_NAME}] ${message}`);
  } catch {
    /* 日志失败不影响 prompt 构建 */
  }
}

// ---------------------------------------------------------------- 路径
export function dshHome(env = process.env) {
  const fromEnv = env?.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

export function stateFilePath(env = process.env) {
  return path.join(dshHome(env), 'bot', 'state.json');
}

// ---------------------------------------------------------------- 权威配置
export function withDefaults(config = {}) {
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  if (!merged.fileByRoom || typeof merged.fileByRoom !== 'object') merged.fileByRoom = {};
  if (!Number.isFinite(merged.maxChars) || merged.maxChars <= 0) merged.maxChars = DEFAULTS.maxChars;
  if (!Number.isFinite(merged.refreshMs) || merged.refreshMs < 0) merged.refreshMs = DEFAULTS.refreshMs;
  merged.enabled = merged.enabled !== false;
  return merged;
}

// ---------------------------------------------------------------- 缓存
const stateCache = new Map(); // absPath -> { mtimeMs, size, checkedAt, value }
const fileCache = new Map(); // absPath -> { mtimeMs, size, text }

export function clearCache() {
  stateCache.clear();
  fileCache.clear();
}

// state.json：mtime/size 变了才重读；refreshMs 内连 stat 都不做。
export function readStateCached(filePath, { refreshMs = DEFAULTS.refreshMs, now = Date.now() } = {}) {
  const hit = stateCache.get(filePath);
  if (hit && now - hit.checkedAt < refreshMs) return hit.value;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    const code = error?.code || 'STAT';
    if (code !== 'ENOENT' && code !== 'EACCES') throw error;
    const value = { ok: false, code, state: null };
    stateCache.set(filePath, { mtimeMs: -1, size: -1, checkedAt: now, value });
    return value;
  }
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    stateCache.set(filePath, { ...hit, checkedAt: now });
    return hit.value;
  }
  let value;
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    value = { ok: true, code: 'OK', state };
  } catch (error) {
    value = { ok: false, code: error?.code || 'PARSE', state: null };
  }
  stateCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now, value });
  return value;
}

// 规则文件：mtime/size 变了才重读，故改文件后下一轮自动生效、不需要重启。
export function readTextFileCached(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fileCache.delete(filePath);
    const code = error?.code || 'STAT';
    return { ok: false, code: code === 'ENOENT' || code === 'EACCES' ? code : 'STAT', text: '' };
  }
  const hit = fileCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return { ok: true, code: 'OK', text: hit.text };
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return { ok: true, code: 'OK', text };
  } catch (error) {
    fileCache.delete(filePath);
    return { ok: false, code: error?.code || 'READ', text: '' };
  }
}

// ---------------------------------------------------------------- 群归属
// state.json 结构（ds-bot）：rooms[roomId].sessions[botId] = sessionId，历史段在 room.parts[].sessionId。
// 传入的 agentId 是会话 id，所以比对的是 sessions 的**值**。
export function findRoomForAgent(state, agentId) {
  if (!agentId || typeof agentId !== 'string') return null;
  const rooms = state?.rooms;
  if (!rooms || typeof rooms !== 'object') return null;
  const entries = Object.entries(rooms).filter(([, room]) => room && typeof room === 'object');
  for (const [roomId, room] of entries) {
    const sessions = room.sessions;
    if (sessions && typeof sessions === 'object') {
      for (const sid of Object.values(sessions)) {
        if (sid === agentId) return { roomId, room, via: 'sessions' };
      }
    }
  }
  for (const [roomId, room] of entries) {
    const parts = Array.isArray(room.parts) ? room.parts : [];
    if (parts.some((part) => part && part.sessionId === agentId)) return { roomId, room, via: 'parts' };
  }
  return null;
}

export function resolveRulesFile(config, roomId) {
  const merged = withDefaults(config);
  const byRoom = merged.fileByRoom?.[roomId];
  const chosen = typeof byRoom === 'string' && byRoom.trim() ? byRoom.trim() : merged.defaultFile;
  return typeof chosen === 'string' ? chosen.trim() : '';
}

// ---------------------------------------------------------------- 渲染
export function renderRules(roomName, body, maxChars = DEFAULTS.maxChars) {
  const text = String(body ?? '');
  if (!text.trim()) return '';
  const header = `# 群聊规则（${roomName || '未命名群'}）\n\n以下是本群的规则全文，在本群内始终有效；私聊时以你的角色说明为准。\n\n`;
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULTS.maxChars;
  const combined = header + text;
  if (combined.length <= limit) return combined;
  const note = `\n\n（规则全文超过 ${limit} 字符上限，已截断；完整内容见规则文件。）`;
  const keep = Math.max(0, limit - header.length - note.length);
  return header + text.slice(0, keep) + note;
}

// ---------------------------------------------------------------- 主入口（纯函数，可单测）
export function textFor(agentId, options = {}) {
  const { config = {}, env = process.env, logger = null, now = Date.now() } = options;
  const merged = withDefaults(config);
  if (!merged.enabled) return '';

  const statePath = options.statePath || stateFilePath(env);
  let read;
  try {
    read = readStateCached(statePath, { refreshMs: merged.refreshMs, now });
  } catch (error) {
    warnOnce(logger, 'state-read', `读取 ${statePath} 失败：${error?.message || error}`);
    return '';
  }
  if (!read.ok) {
    if (read.code !== 'ENOENT') warnOnce(logger, `state-${read.code}`, `读取或解析 ${statePath} 失败（code=${read.code}）`);
    return '';
  }

  const found = findRoomForAgent(read.state, agentId);
  if (!found) return ''; // 私聊/非群会话：不注入

  const rulesFile = resolveRulesFile(merged, found.roomId);
  if (!rulesFile) return '';

  const file = readTextFileCached(rulesFile);
  if (!file.ok) {
    warnOnce(logger, `rules-${file.code}`, `读取规则文件 ${rulesFile} 失败（code=${file.code}）`);
    return '';
  }

  return renderRules(found.room?.name, file.text, merged.maxChars);
}

// ---------------------------------------------------------------- 插件装配
export function apply(ctx, config = {}) {
  let current = withDefaults(config);
  const logger = ctx?.logger || null;

  // 段文本按轮求值：命中群、有规则文件才给文本，否则空串（空串不进 prompt）。
  const buildText = (context) => {
    try {
      return textFor(context?.agent?.id, { config: current, logger }) ?? '';
    } catch (error) {
      // 绝不向 prompt 构建抛错
      warnOnce(logger, 'text-throw', `构建群规则段失败：${error?.message || error}`);
      return '';
    }
  };

  const install = (sctx) => {
    const dispose = sctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: buildText,
    });
    if (typeof sctx.effect === 'function') {
      sctx.effect(() => () => {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载期的清理失败不阻塞 */
        }
      }, `${PLUGIN_NAME}: dispose system prompt section`);
    }
    return dispose;
  };

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['systemPrompt'], install);
  } else if (ctx?.systemPrompt?.section) {
    install(ctx);
  } else {
    warnOnce(logger, 'no-system-prompt', '宿主没有 systemPrompt 服务，跳过一次（插件不会报错）');
  }

  return {
    name: PLUGIN_NAME,
    section: SECTION_NAME,
    order: SECTION_ORDER,
    reconfigure(next) {
      current = withDefaults(next);
    },
    textFor: (agentId) => textFor(agentId, { config: current, logger }),
  };
}

export default { name, apply, inject, textFor };
