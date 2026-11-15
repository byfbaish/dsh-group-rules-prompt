// dsh-group-rules-prompt 单测：node --test lib/index.test.mjs
// 覆盖规格 §4 的五条：命中、非群会话、文件缺失、state.json 读取失败、mtime 缓存。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  textFor,
  findRoomForAgent,
  renderRules,
  withDefaults,
  clearCache,
  resolveRulesFile,
  SECTION_NAME,
  SECTION_ORDER,
} from './index.js';

// ds-bot 的映射是 rooms[roomId].sessions[botId] = sessionId；注入时拿到的是会话 id。
const BOT_ID = 'bot-a1b2c3d4';
const GROUP_SESSION = 'session-group-1';
const PRIVATE_SESSION = 'session-private-9';
const ROOM_ID = 'session-4f78136d-2080-4806-ba83-0e5295209594';

function makeSandbox({ withRules = true, withState = true, stateRaw = null, rulesText = '# 群规 v1\n\n一、人类指令最高。\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-rules-'));
  const home = path.join(root, 'dsh');
  const botDir = path.join(home, 'bot');
  fs.mkdirSync(botDir, { recursive: true });
  const statePath = path.join(botDir, 'state.json');
  const rulesPath = path.join(root, 'GROUP-RULES.md');
  if (withRules) fs.writeFileSync(rulesPath, rulesText, 'utf8');
  if (withState) {
    const state = {
      rooms: {
        [ROOM_ID]: {
          name: 'AI writer项目组',
          sessions: { [BOT_ID]: GROUP_SESSION },
          parts: [{ sessionId: GROUP_SESSION }],
        },
        'room-private': { name: '私聊', sessions: {}, parts: [{ sessionId: PRIVATE_SESSION }] },
      },
    };
    fs.writeFileSync(statePath, stateRaw ?? JSON.stringify(state), 'utf8');
  }
  return { root, home, statePath, rulesPath, env: { DSH_HOME: home } };
}

function hit(box, extra = {}) {
  return textFor(GROUP_SESSION, { env: box.env, config: { defaultFile: box.rulesPath, ...extra } });
}

test('① 命中：群成员会话拿到规则段，标题带群名', () => {
  clearCache();
  const box = makeSandbox();
  const text = hit(box);
  assert.match(text, /^# 群聊规则（AI writer项目组）/);
  assert.match(text, /一、人类指令最高。/);
  assert.match(text, /在本群内始终有效/);
});

test('①b 命中：群名缺失时用「未命名群」，不抛错', () => {
  clearCache();
  const box = makeSandbox();
  fs.writeFileSync(box.statePath, JSON.stringify({ rooms: { [ROOM_ID]: { sessions: { [BOT_ID]: GROUP_SESSION } } } }), 'utf8');
  assert.match(hit(box), /# 群聊规则（未命名群）/);
});

test('② 非群会话：不在任何 room 里的会话 id 返回空串（不注入）', () => {
  clearCache();
  const box = makeSandbox();
  assert.equal(textFor('session-unknown-xyz', { env: box.env, config: { defaultFile: box.rulesPath } }), '');

  const state = JSON.parse(fs.readFileSync(box.statePath, 'utf8'));
  assert.equal(findRoomForAgent(state, GROUP_SESSION)?.roomId, ROOM_ID);
  assert.equal(findRoomForAgent(state, BOT_ID), null, 'botId 不是会话 id，不该命中');
});

test('②b 历史段回退：只有 parts[].sessionId 命中时也算群会话', () => {
  clearCache();
  const box = makeSandbox();
  fs.writeFileSync(
    box.statePath,
    JSON.stringify({ rooms: { 'room-old': { name: '旧群', parts: [{ sessionId: 'agent-hist-bot' }] } } }),
    'utf8',
  );
  assert.match(textFor('agent-hist-bot', { env: box.env, config: { defaultFile: box.rulesPath } }), /# 群聊规则（旧群）/);
});

test('③ 文件缺失：规则文件不存在 → 空串，且不抛错', () => {
  clearCache();
  const box = makeSandbox({ withRules: false });
  assert.equal(textFor(GROUP_SESSION, { env: box.env, config: { defaultFile: path.join(box.root, 'nope.md') } }), '');
  clearCache();
  assert.equal(textFor(GROUP_SESSION, { env: box.env, config: {} }), '', '没配文件也返回空串');
});

test('④ state.json 读取失败（不存在/坏 JSON）→ 空串，不抛错', () => {
  clearCache();
  const boxNoState = makeSandbox({ withState: false });
  assert.equal(textFor(GROUP_SESSION, { env: boxNoState.env, config: { defaultFile: boxNoState.rulesPath } }), '');

  clearCache();
  const boxBadJson = makeSandbox({ stateRaw: '{"rooms": {' });
  assert.equal(textFor(GROUP_SESSION, { env: boxBadJson.env, config: { defaultFile: boxBadJson.rulesPath } }), '');
});

test('⑤ 缓存：规则文件按 mtime 失效（改文件下轮即生效，不必重启），state.json 按 refreshMs 节流', async () => {
  clearCache();
  const box = makeSandbox();
  const config = { defaultFile: box.rulesPath, refreshMs: 50 };
  assert.match(hit(box, config), /群规 v1/);

  // 规则文件：写后 mtime 变 → 立即重读（不等 TTL），这是要的行为
  await new Promise((resolve) => setTimeout(resolve, 10));
  fs.writeFileSync(box.rulesPath, '# 群规 v2\n\n二、改动后应生效。\n', 'utf8');
  const after = hit(box, config);
  assert.match(after, /群规 v2/);
  assert.doesNotMatch(after, /群规 v1/);
});

test('⑤b state.json：refreshMs 内不重读，越过 TTL 才看到新房间', async () => {
  clearCache();
  const box = makeSandbox();
  const config = { defaultFile: box.rulesPath, refreshMs: 60 };
  assert.match(hit(box, config), /AI writer项目组/);

  const moved = {
    rooms: { [ROOM_ID]: { name: '改名后的群', sessions: { [BOT_ID]: GROUP_SESSION } } },
  };
  fs.writeFileSync(box.statePath, JSON.stringify(moved), 'utf8');
  assert.match(hit(box, config), /AI writer项目组/, 'TTL 内仍读缓存');

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.match(hit(box, config), /改名后的群/);
});

test('⑥ 截断：超过 maxChars 加注记，且不超上限', () => {
  const out = renderRules('群A', 'x'.repeat(500), 200);
  assert.ok(out.length <= 200, `len=${out.length}`);
  assert.match(out, /已截断/);
});

test('⑦ 配置合并与默认值', () => {
  const cfg = withDefaults({ maxChars: 0, refreshMs: -1, fileByRoom: null });
  assert.equal(cfg.maxChars, 20000);
  assert.equal(cfg.refreshMs, 2000);
  assert.deepEqual(cfg.fileByRoom, {});
  assert.equal(cfg.enabled, true);
  assert.equal(withDefaults({ enabled: false }).enabled, false);
  assert.equal(resolveRulesFile({ defaultFile: 'a.md', fileByRoom: { r1: 'b.md' } }, 'r1'), 'b.md');
  assert.equal(resolveRulesFile({ defaultFile: 'a.md', fileByRoom: { r1: 'b.md' } }, 'r2'), 'a.md');
});

test('⑧ enabled=false 时不注入', () => {
  clearCache();
  const box = makeSandbox();
  assert.equal(hit(box, { enabled: false }), '');
});

test('⑨ 空规则文件不注入', () => {
  clearCache();
  const box = makeSandbox({ rulesText: '   \n\n' });
  assert.equal(hit(box), '');
});

test('⑩ 段名与顺序按规格', () => {
  assert.equal(SECTION_NAME, 'group-rules');
  assert.equal(SECTION_ORDER, 645);
});

test('⑪ apply 装配：宿主无 systemPrompt 服务时不抛错', () => {
  const logs = [];
  const plugin = null;
  // 直接导出的 apply 用假 ctx 调一次，验证降级路径
  const mod = { name: 'x' };
  assert.ok(mod);
  // 通过动态导入拿到 apply，避免在顶部再引一次
  return import('./index.js').then(({ apply }) => {
    const fakeCtx = { logger: { warn: (m) => logs.push(m) } };
    const handle = apply(fakeCtx, { defaultFile: '' });
    assert.equal(handle.section, 'group-rules');
    assert.equal(handle.order, 645);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /没有 systemPrompt 服务/);
    assert.equal(plugin, null);
  });
});
