import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSay, loadSeats } from '../src/seats.mjs';
import { createRoundtableServer } from '../src/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI_PATH = join(REPO_ROOT, 'bin', 'cli.mjs');

async function startTestServer(opts) {
  const ctx = createRoundtableServer(opts);
  await new Promise((resolve, reject) => {
    ctx.server.once('error', reject);
    ctx.server.listen(0, '127.0.0.1', resolve);
  });
  const port = ctx.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise(resolve => {
    ctx.server.closeAllConnections?.();
    ctx.server.close(resolve);
  });
  return { ...ctx, baseUrl, close };
}

test('CLI --help 和 --doctor 正常退出并输出检测结果', () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-cli-test-'));
  try {
    const helpOut = execFileSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
    assert.match(helpOut, /实时圆桌/);
    assert.match(helpOut, /--doctor/);

    const docOut = execFileSync(process.execPath, [CLI_PATH, '--doctor', '--data-dir', tmpData], { encoding: 'utf8' });
    assert.match(docOut, /Node 版本:/);
    assert.match(docOut, new RegExp(tmpData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(docOut, /opus/);
    assert.match(docOut, /astra/);
    assert.match(docOut, /gemini/);
  } finally {
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('缺失部分 CLI 时 /api/meta 正确标记可用席位，且本地静态资源返回 200', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-meta-test-'));
  const findBinFn = cmd => (cmd === 'codex' ? '/mock/bin/codex' : null);
  const srv = await startTestServer({ dataDir: tmpData, findBinFn });
  try {
    const htmlRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /\/vendor\/marked\.min\.js/);
    assert.doesNotMatch(html, /fonts\.googleapis\.com/);

    const markedRes = await fetch(`${srv.baseUrl}/vendor/marked.min.js`);
    assert.equal(markedRes.status, 200);
    const markedJs = await markedRes.text();
    assert.ok(markedJs.length > 10_000);
    assert.match(markedJs, /marked/);

    const markedHeadRes = await fetch(`${srv.baseUrl}/vendor/marked.min.js`, { method: 'HEAD' });
    assert.equal(markedHeadRes.status, 200);

    const metaRes = await fetch(`${srv.baseUrl}/api/meta`);
    assert.equal(metaRes.status, 200);
    const meta = await metaRes.json();

    assert.equal(meta.features.research, false);
    assert.equal(meta.seats.opus.available, false);
    assert.equal(meta.seats.fable.available, false);
    assert.equal(meta.seats.gemini.available, false);
    assert.equal(meta.seats.astra.available, true);
    assert.equal(meta.seats.sol.available, true);
    assert.deepEqual(meta.defaults.seats, ['astra', 'sol']);
    assert.equal(meta.defaults.efforts.sol, 'xhigh');
    assert.ok(meta.special.rank.template.includes('找秩'));
    assert.ok(meta.special.book.template.includes('书名'));
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('Opus 不可用时自动切换可用席位任主持人，并完成独立回答→定焦→互评→总结', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-ask-test-'));
  const findBinFn = cmd => (cmd === 'codex' ? '/mock/bin/codex' : null);
  const calls = [];
  const sayFn = async (seatId, opts) => {
    calls.push({ seatId, system: opts.system, prompt: opts.prompt });
    if (opts.system.includes('只负责让讨论往深处走')) {
      return { text: '**核心分歧**：astra 和 sol 优先级不同（判断标准不同）\n**这轮请回答**：哪个指标先验证？', ms: 12, usage: null, usd: 0, speed: 'priority', sources: [], searches: [], error: null };
    }
    if (opts.system.includes('中立主持人')) {
      return { text: '## 回答\n先用小规模真实样本验证。\n## 下一层问题\n样本量最少需要多少？\n## 深挖这处分歧\n无', ms: 15, usage: null, usd: 0, speed: 'priority', sources: [], searches: [], error: null };
    }
    if (opts.prompt.includes('主持人刚指出了核心分歧')) {
      return { text: `MOCK_${seatId.toUpperCase()}_RESPOND`, ms: 10, usage: null, usd: 0, speed: 'priority', sources: [], searches: [], error: null };
    }
    return { text: `MOCK_${seatId.toUpperCase()}_ASK`, ms: 10, usage: null, usd: 0, speed: 'priority', sources: [], searches: [], error: null };
  };

  const srv = await startTestServer({ dataDir: tmpData, findBinFn, sayFn });
  try {
    const conv = await (await fetch(`${srv.baseUrl}/api/convs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { rounds: 1, autoSummary: true } }),
    })).json();
    assert.deepEqual(conv.settings.seats, ['astra', 'sol']);

    const sayRes = await fetch(`${srv.baseUrl}/api/convs/${conv.id}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', text: '我们该先做网页还是先做 CLI？' }),
    });
    assert.equal(sayRes.status, 200);
    const sayBody = await sayRes.json();
    assert.equal(sayBody.ok, true);

    // 首轮 astra 和 sol 互相看不到彼此的回答
    const askCalls = calls.filter(
      c => !c.system.includes('中立主持人')
        && !c.system.includes('只负责让讨论往深处走')
        && !c.prompt.includes('主持人刚指出了核心分歧'),
    );
    assert.equal(askCalls.length, 2);
    for (const c of askCalls) {
      assert.doesNotMatch(c.prompt, /MOCK_ASTRA_ASK|MOCK_SOL_ASK/);
    }

    // 主持人应自动落到第一个可用席位 astra（opus 未安装）
    const saved = await (await fetch(`${srv.baseUrl}/api/convs/${conv.id}`)).json();
    assert.deepEqual(
      saved.messages.map(m => ({ role: m.role, seat: m.seat ?? null, mode: m.mode ?? null })),
      [
        { role: 'user', seat: null, mode: null },
        { role: 'seat', seat: 'astra', mode: 'ask' },
        { role: 'seat', seat: 'sol', mode: 'ask' },
        { role: 'moderator', seat: 'astra', mode: 'focus' },
        { role: 'seat', seat: 'astra', mode: 'respond' },
        { role: 'seat', seat: 'sol', mode: 'respond' },
        { role: 'summary', seat: 'astra', mode: 'summary' },
      ],
    );

    const diskPath = join(tmpData, 'conversations', `${conv.id}.json`);
    assert.equal(existsSync(diskPath), true);
    const diskJson = JSON.parse(readFileSync(diskPath, 'utf8'));
    assert.equal(diskJson.messages.length, 7);
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('特别模式「找秩」走通清单→作答→无分歧提前收束→总结', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-rank-test-'));
  const findBinFn = cmd => (cmd === 'claude' || cmd === 'codex' ? `/mock/bin/${cmd}` : null);
  const sayFn = async (seatId, opts) => {
    if (opts.system.includes('只列问题')) {
      return { text: 'Q1 问题一\nQ2 问题二', ms: 5, usage: null, usd: 0, speed: 'standard', sources: [], searches: [], error: null };
    }
    if (opts.system.includes('只负责让讨论往深处走')) {
      return { text: '【无分歧】各位给出的秩完全一致。', ms: 5, usage: null, usd: 0, speed: 'standard', sources: [], searches: [], error: null };
    }
    if (opts.system.includes('中立主持人')) {
      return { text: '## 秩\n1. 基本问题①', ms: 5, usage: null, usd: 0, speed: 'standard', sources: [], searches: [], error: null };
    }
    return { text: `${seatId} 找秩拆解`, ms: 5, usage: null, usd: 0, speed: 'standard', sources: [], searches: [], error: null };
  };

  const srv = await startTestServer({ dataDir: tmpData, findBinFn, sayFn });
  try {
    const conv = await (await fetch(`${srv.baseUrl}/api/convs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { seats: ['opus', 'astra'], rounds: 2, autoSummary: true } }),
    })).json();

    const sayRes = await fetch(`${srv.baseUrl}/api/convs/${conv.id}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rank', text: '【要找秩的事】要不要重做官网' }),
    });
    assert.equal(sayRes.status, 200);

    const saved = await (await fetch(`${srv.baseUrl}/api/convs/${conv.id}`)).json();
    assert.deepEqual(
      saved.messages.map(m => ({ role: m.role, seat: m.seat ?? null, mode: m.mode ?? null, kind: m.kind ?? null })),
      [
        { role: 'user', seat: null, mode: null, kind: 'rank' },
        { role: 'moderator', seat: 'opus', mode: 'inventory', kind: 'rank' },
        { role: 'seat', seat: 'opus', mode: 'special-ask', kind: 'rank' },
        { role: 'seat', seat: 'astra', mode: 'special-ask', kind: 'rank' },
        { role: 'moderator', seat: 'opus', mode: 'special-focus', kind: 'rank' },
        { role: 'summary', seat: 'opus', mode: 'special-summary', kind: 'rank' },
      ],
    );
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('支持自定义 seats.json 覆盖与停用席位，缺失 CLI 时 createSay 返回可读错误', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-seats-test-'));
  try {
    writeFileSync(
      join(tmpData, 'seats.json'),
      JSON.stringify({
        seats: {
          gemini: false,
          opus: { model: '', label: 'Opus 默认' },
          custom: { cli: 'claude', model: 'claude-sonnet-4-6', label: 'Sonnet 自定义' },
        },
      }),
    );
    const { seats, configPath } = loadSeats({ dataDir: tmpData });
    assert.equal(configPath, join(tmpData, 'seats.json'));
    assert.equal(seats.gemini, undefined);
    assert.equal(seats.opus.model, '');
    assert.equal(seats.opus.label, 'Opus 默认');
    assert.equal(seats.custom.vendor, 'anthropic');

    const localSay = createSay({ seats, findBinFn: () => null });
    const res = await localSay('opus', { system: 's', prompt: 'p' });
    assert.equal(res.text, '');
    assert.match(res.error, /未检测到 claude 命令/);
  } finally {
    rmSync(tmpData, { recursive: true, force: true });
  }
});
