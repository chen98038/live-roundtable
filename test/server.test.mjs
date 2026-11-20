import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyError, createSay, loadSeats, probeSeat } from '../src/seats.mjs';
import { BARE_PATH_ERROR, createRoundtableServer, isBarePath, LEAK_ERROR, MAX_OUT, outputProblem } from '../src/server.mjs';

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

    for (const font of ['Montserrat-subset.woff2', 'NotoSansSC-subset.woff2']) {
      assert.match(html, new RegExp(`/vendor/fonts/${font.replace('.', '\\.')}`));
      const fontRes = await fetch(`${srv.baseUrl}/vendor/fonts/${font}`);
      assert.equal(fontRes.status, 200);
      assert.equal(fontRes.headers.get('content-type'), 'font/woff2');
      assert.equal(Buffer.from(await fontRes.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
    }
    assert.equal((await fetch(`${srv.baseUrl}/vendor/fonts/OFL-Montserrat.txt`)).status, 404);

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

test('主持人可单独指定模型和思考强度，不影响参与者的思考强度', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-mod-test-'));
  const findBinFn = cmd => (cmd === 'claude' || cmd === 'codex' ? `/mock/bin/${cmd}` : null);
  const calls = [];
  const ok = text => ({ text, ms: 5, usage: null, usd: 0, speed: 'standard', sources: [], searches: [], error: null });
  const sayFn = async (seatId, opts) => {
    const role = opts.system.includes('中立主持人') ? 'summary' : opts.system.includes('只负责让讨论往深处走') ? 'moderator' : 'seat';
    calls.push({ seatId, role, effort: opts.effort });
    return ok(role === 'moderator' ? '【无分歧】已经说清楚了' : role === 'summary' ? '## 回答\n好' : `MOCK_${seatId}`);
  };
  const srv = await startTestServer({ dataDir: tmpData, findBinFn, sayFn });
  try {
    const conv = await (await fetch(`${srv.baseUrl}/api/convs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {} }),
    })).json();
    assert.equal(conv.settings.moderatorEffort, '');

    const setRes = await fetch(`${srv.baseUrl}/api/convs/${conv.id}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seats: ['opus', 'astra'], moderator: 'sol', moderatorEffort: 'max', efforts: { astra: 'low' }, rounds: 1, autoSummary: true }),
    });
    assert.equal(setRes.status, 200);

    await fetch(`${srv.baseUrl}/api/convs/${conv.id}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ask', text: '先做哪个？' }),
    });
    for (let i = 0; i < 50 && !calls.some(c => c.role === 'summary'); i++) await new Promise(r => setTimeout(r, 20));

    assert.deepEqual(
      calls.map(c => [c.seatId, c.role, c.effort]).sort(),
      [['astra', 'seat', 'low'], ['opus', 'seat', 'high'], ['sol', 'moderator', 'max'], ['sol', 'summary', 'max']],
    );
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

test('连接自检：把各家 CLI 的真实报错归类，并给出修复步骤', () => {
  const cases = [
    ['claude', 'Not logged in · Please run /login', 'login', /\/login/],
    ['codex', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses', 'login', /codex login/],
    ['agy', 'authentication failed or timed out', 'login', /agy/],
    ['claude', "There's an issue with the selected model (claude-no-such). It may not exist or you may not have access to it.", 'model', /默认模型/],
    ['codex', "The 'gpt-no-such-model' model is not supported when using Codex with a ChatGPT account.", 'model', /默认模型/],
    ['agy', 'invalid model selection (--model "gemini-no-such" --effort "low"): --effort is not supported for model "gemini-no-such"', 'model', /默认模型/],
    ['codex', "error: unexpected argument '--ignore-user-config' found", 'version', /0\.169.*npm install -g @openai\/codex/],
    ['agy', 'failed to start conversation: backend returned an empty conversation id', 'transient', /稍后/],
    ['codex', 'request id: req_aba401cd 连接失败 fetch failed', 'network', /网络/],
    ['claude', '超时：120 秒没有回复', 'timeout', /稍后/],
    ['claude', '一个没见过的错误', 'other', /原始报错/],
  ];
  for (const [cli, msg, kind, fix] of cases) {
    const c = classifyError(cli, msg);
    assert.equal(c.kind, kind, msg);
    assert.match(c.fix, fix, msg);
  }
});

test('连接自检：没装、能用、模型用不了自动退回默认模型、偶发错误重试一次、超时', async () => {
  const seat = { cli: 'codex', vendor: 'openai', model: 'gpt-6.2-sol', label: 'sol' };
  const has = () => '/mock/codex';

  const missing = await probeSeat(seat, { findBinFn: () => null });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, 'missing');
  assert.match(missing.fix, /npm install -g @openai\/codex/);

  const ok = await probeSeat(seat, { findBinFn: has, runFn: async () => ({ text: '收到' }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.fallbackFrom, undefined);

  const models = [];
  const fb = await probeSeat(seat, {
    findBinFn: has,
    runFn: async s => (models.push(s.model), s.model ? { text: '', error: "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account." } : { text: '收到' }),
  });
  assert.deepEqual(models, ['gpt-6.2-sol', '']);
  assert.equal(fb.ok, true);
  assert.equal(fb.fallbackFrom, 'gpt-6.2-sol');

  let calls = 0;
  const flaky = await probeSeat(seat, {
    findBinFn: has,
    runFn: async () => (++calls === 1 ? { text: '', error: 'backend returned an empty conversation id' } : { text: '收到' }),
  });
  assert.equal(calls, 2);
  assert.equal(flaky.ok, true);

  calls = 0;
  const login = await probeSeat(seat, { findBinFn: has, runFn: async () => (calls++, { text: '', error: 'Not logged in' }) });
  assert.equal(calls, 1, '没登录不需要重试');
  assert.equal(login.kind, 'login');

  const slow = await probeSeat(seat, {
    findBinFn: has,
    timeoutMs: 30,
    runFn: (s, opts) => new Promise(ok => opts.signal.addEventListener('abort', () => ok({ text: '', error: '已停止' }))),
  });
  assert.equal(slow.kind, 'timeout');
});

test('/api/probe：失败的席位默认不参加，模型回退落盘且重启后仍生效', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-probe-test-'));
  const findBinFn = cmd => (cmd === 'claude' ? null : `/mock/bin/${cmd}`);
  const runSeatFn = async seat => {
    if (seat.cli === 'codex' && seat.label.includes('astra')) return { text: '', error: 'unexpected status 401 Unauthorized' };
    if (seat.cli === 'codex' && seat.model) return { text: '', error: "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account." };
    return { text: '收到' };
  };
  let srv = await startTestServer({ dataDir: tmpData, findBinFn, runSeatFn });
  try {
    let meta = await (await fetch(`${srv.baseUrl}/api/meta`)).json();
    assert.equal(meta.probe.checked, false, '首次使用还没检查过');
    assert.equal(meta.seats.astra.setup.name, 'OpenAI Codex CLI');

    const r = await (await fetch(`${srv.baseUrl}/api/probe`, { method: 'POST', body: '{}' })).json();
    assert.equal(r.seats.opus.available, false);
    assert.equal(r.seats.opus.probe.kind, 'missing');
    assert.equal(r.seats.astra.probe.ok, false);
    assert.equal(r.seats.astra.probe.kind, 'login');
    assert.equal(r.seats.sol.probe.ok, true);
    assert.equal(r.seats.sol.probe.fallbackFrom, 'gpt-6.2-sol');
    assert.equal(r.seats.sol.model, '');
    assert.equal(r.seats.gemini.probe.ok, true);
    assert.deepEqual(r.defaults.seats, ['sol', 'gemini', 'carbon']);

    const fbs = JSON.parse(readFileSync(join(tmpData, 'model-fallbacks.json'), 'utf8'));
    assert.equal(fbs.sol.from, 'gpt-6.2-sol');
    assert.ok(existsSync(join(tmpData, 'probe.json')));

    const conv = await (await fetch(`${srv.baseUrl}/api/convs`, { method: 'POST', body: '{}' })).json();
    assert.deepEqual(conv.settings.seats, ['sol', 'gemini', 'carbon']);
  } finally {
    await srv.close();
  }

  // 重启：回退和检查结果都还在
  srv = await startTestServer({ dataDir: tmpData, findBinFn, runSeatFn: async () => ({ text: '收到' }) });
  try {
    let meta = await (await fetch(`${srv.baseUrl}/api/meta`)).json();
    assert.equal(meta.probe.checked, true);
    assert.equal(meta.seats.sol.model, '');
    assert.equal(meta.seats.sol.fallbackFrom, 'gpt-6.2-sol');
    assert.equal(meta.seats.astra.probe.kind, 'login');

    // 原模型又能用了：重新检查后恢复原模型，回退记录删掉
    const r = await (await fetch(`${srv.baseUrl}/api/probe`, { method: 'POST', body: '{}' })).json();
    assert.equal(r.seats.sol.model, 'gpt-6.2-sol');
    assert.equal(r.seats.sol.fallbackFrom, undefined);
    assert.equal(r.seats.astra.probe.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(join(tmpData, 'model-fallbacks.json'), 'utf8')), {});
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('/api/convs/:id/prepare：根据问题自动生成背景和各席位角色并保存，异常返回不污染原设置', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-prepare-test-'));
  const findBinFn = cmd => (cmd === 'codex' || cmd === 'agy' ? `/mock/bin/${cmd}` : null);
  const calls = [];
  let mode = 'fenced';
  const sayFn = async (seatId, opts) => {
    calls.push({ seatId, web: opts.web, effort: opts.effort, prompt: opts.prompt });
    if (mode === 'bad') return { text: '这不是 JSON 内容', ms: 10, error: null };
    return {
      text: '```json\n' + JSON.stringify({
        background: '目标：评估 6 个月内是否自研推荐系统。\n约束：【待补充：团队人数与预算】',
        personas: {
          astra: '负责落地排期与研发成本核算，关注投入产出比',
          gemini: '唱反调，专挑自研风险、隐性运维成本和失败案例',
          opus: '这个席位没装，不应该被写入',
        },
        missing: ['当前日活规模', '可投入的工程师人数'],
      }) + '\n```',
      ms: 25,
      error: null,
    };
  };

  const srv = await startTestServer({ dataDir: tmpData, findBinFn, sayFn });
  try {
    const conv = await (await fetch(`${srv.baseUrl}/api/convs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { seats: ['astra', 'gemini'] } }),
    })).json();

    // 空文本返回 400
    const emptyRes = await fetch(`${srv.baseUrl}/api/convs/${conv.id}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(emptyRes.status, 400);

    // 正常配局：解析带 markdown 代码块的 JSON，过滤未参加席位，并落盘
    const res = await fetch(`${srv.baseUrl}/api/convs/${conv.id}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '我们要不要自研一套推荐系统？' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.seat, 'astra');
    assert.match(data.background, /自研推荐系统/);
    assert.deepEqual(Object.keys(data.personas).sort(), ['astra', 'gemini']);
    assert.equal(data.personas.opus, undefined);
    assert.deepEqual(data.missing, ['当前日活规模', '可投入的工程师人数']);
    assert.equal(calls[0].web, false);
    assert.equal(calls[0].effort, 'medium');

    const saved = await (await fetch(`${srv.baseUrl}/api/convs/${conv.id}`)).json();
    assert.equal(saved.settings.background, data.background);
    assert.equal(saved.settings.personas.astra, data.personas.astra);
    assert.equal(saved.settings.personas.gemini, data.personas.gemini);
    assert.equal(saved.settings.personas.opus, undefined);

    // 返回非 JSON 时报 502，且不破坏已有设置
    mode = 'bad';
    const badRes = await fetch(`${srv.baseUrl}/api/convs/${conv.id}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '换个问题' }),
    });
    assert.equal(badRes.status, 502);
    const afterBad = await (await fetch(`${srv.baseUrl}/api/convs/${conv.id}`)).json();
    assert.equal(afterBad.settings.background, data.background);
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

const ok = text => ({ text, ms: 5, usage: null, usd: 0, speed: 'standard', sources: [], searches: [], error: null });
const LEAK = '<invoke name="Read">\n<parameter name="file_path">/Users/a/book.md</parameter>\n</invoke>\n\n';
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('输出守卫：工具调用写成正文、输出超长就判错；正文里偶尔提到一次不误伤', () => {
  assert.equal(outputProblem(LEAK), LEAK_ERROR);
  assert.equal(outputProblem(`我先读一下文件\n${LEAK}${LEAK}${LEAK}`), LEAK_ERROR);
  assert.equal(outputProblem('Claude 的工具调用长这样：<invoke name="Read">，这里只是举例'), null);
  assert.match(outputProblem('字'.repeat(MAX_OUT + 1)), /已中止/);
  assert.equal(outputProblem('正常的发言'), null);
});

test('整条消息只是本地路径时识别出来，夹在句子里的路径和「/ 这个符号」不算', () => {
  for (const s of ['/Users/a/clew/feed/babble-and-prune.md', '~/notes/x.md', 'file:///Users/a/b.md', 'C:\\books\\a.txt', '/Users/x/My Books/a.md', '@opus /Users/a/b.md']) {
    assert.equal(isBarePath(s), true, s);
  }
  for (const s of ['/ 这个符号怎么读', '/help', '/usr/bin 是干嘛的', '看看 /Users/a/b.md', '/Users/a/b.md 讲了什么？', '帮我读\n/Users/a/b.md']) {
    assert.equal(isBarePath(s), false, s);
  }
});

test('三把尺读书：主持人列清单时吐工具调用，马上中止、标错，整场停下，流式开始时就带步骤信息', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-leak-test-'));
  const findBinFn = cmd => (cmd === 'claude' || cmd === 'codex' ? `/mock/bin/${cmd}` : null);
  const calls = [];
  let chunks = 0;
  const sayFn = async (seatId, opts) => {
    calls.push(opts.system);
    if (opts.system.includes('只把书的观点列成清单')) {
      let text = '';
      while (!opts.signal.aborted && chunks < 1000) {
        chunks++;
        text += LEAK;
        opts.onDelta(LEAK);
        await new Promise(r => setImmediate(r));
      }
      return { ...ok(text), error: opts.signal.aborted ? '已停止' : null };
    }
    return ok(`${seatId} 的梳理`);
  };
  const srv = await startTestServer({ dataDir: tmpData, findBinFn, sayFn });
  try {
    const conv = await (await post(`${srv.baseUrl}/api/convs`, { settings: { seats: ['opus', 'astra'], rounds: 1, autoSummary: true } })).json();

    const events = [];
    const ac = new AbortController();
    const sse = await fetch(`${srv.baseUrl}/api/convs/${conv.id}/events`, { signal: ac.signal });
    const reader = sse.body.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 2);
            if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
          }
        }
      } catch {}
    })();

    const res = await post(`${srv.baseUrl}/api/convs/${conv.id}/say`, { mode: 'book', text: '【书】某本书\n【书里的主要观点】见附件' });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 50));
    ac.abort();
    await pump;

    assert.ok(chunks < 10, `守卫应该在几段之内停下，实际吐了 ${chunks} 段`);
    assert.equal(calls.length, 1, '清单失败后不应再让各席位作答');
    const saved = await (await fetch(`${srv.baseUrl}/api/convs/${conv.id}`)).json();
    const inv = saved.messages.find(m => m.mode === 'inventory');
    assert.equal(inv.error, LEAK_ERROR);
    assert.equal(inv.text, '');
    assert.equal(saved.messages.length, 2);

    const start = events.find(e => e.type === 'start' && e.msg.role === 'moderator');
    assert.equal(start.msg.mode, 'inventory');
    assert.equal(start.msg.kind, 'book');
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('不流式的席位（codex）回了工具调用，结束后也会被标错，并且不进入后面的提示', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-leak2-test-'));
  const findBinFn = cmd => (cmd === 'claude' || cmd === 'codex' ? `/mock/bin/${cmd}` : null);
  const prompts = [];
  const sayFn = async (seatId, opts) => {
    prompts.push(opts.prompt);
    if (opts.system.includes('只负责让讨论往深处走')) return ok('【无分歧】都一样。');
    if (opts.system.includes('中立主持人')) return ok('## 回答\n好。');
    return ok(seatId === 'astra' ? `${LEAK}${LEAK}${LEAK}` : 'opus 的回答');
  };
  const srv = await startTestServer({ dataDir: tmpData, findBinFn, sayFn });
  try {
    const conv = await (await post(`${srv.baseUrl}/api/convs`, { settings: { seats: ['opus', 'astra'], rounds: 1, autoSummary: true } })).json();
    assert.equal((await post(`${srv.baseUrl}/api/convs/${conv.id}/say`, { mode: 'ask', text: '这本书讲了什么' })).status, 200);
    const saved = await (await fetch(`${srv.baseUrl}/api/convs/${conv.id}`)).json();
    const astra = saved.messages.find(m => m.seat === 'astra');
    assert.equal(astra.error, LEAK_ERROR);
    assert.equal(astra.text, '');
    assert.ok(prompts.length > 2);
    for (const p of prompts.slice(2)) assert.doesNotMatch(p, /<invoke/);
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('/say 和 /prepare 收到整条只是路径的消息直接 400，不调用模型', async () => {
  const tmpData = mkdtempSync(join(tmpdir(), 'rt-path-test-'));
  const findBinFn = cmd => (cmd === 'claude' ? '/mock/bin/claude' : null);
  let called = 0;
  const sayFn = async () => { called++; return ok('收到'); };
  const srv = await startTestServer({ dataDir: tmpData, findBinFn, sayFn });
  try {
    const conv = await (await post(`${srv.baseUrl}/api/convs`, { settings: { seats: ['opus'], rounds: 0, autoSummary: false } })).json();
    for (const text of ['/Users/a/clew/feed/babble-and-prune.md', '~/x.md', 'file:///Users/a/b.md', 'C:\\a\\b.txt']) {
      for (const [path, body] of [['say', { mode: 'book', text }], ['prepare', { text }]]) {
        const res = await post(`${srv.baseUrl}/api/convs/${conv.id}/${path}`, body);
        assert.equal(res.status, 400, `${path} ${text}`);
        assert.equal((await res.json()).error, BARE_PATH_ERROR);
      }
    }
    assert.equal(called, 0);
    assert.equal((await post(`${srv.baseUrl}/api/convs/${conv.id}/say`, { mode: 'ask', text: '/ 这个符号怎么读' })).status, 200);
    assert.ok(called > 0);
  } finally {
    await srv.close();
    rmSync(tmpData, { recursive: true, force: true });
  }
});

test('Claude 席位的系统提示里写明没有工具、拿到路径要直说读不到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-fakeclaude-'));
  try {
    const bin = join(dir, 'claude');
    writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: a[a.indexOf('--system-prompt') + 1], usage: {} })));
`);
    chmodSync(bin, 0o755);
    const say = createSay({ findBinFn: cmd => (cmd === 'claude' ? bin : null) });
    for (const web of [false, true]) {
      const r = await say('opus', { system: '原来的设定', prompt: '你好', web, fast: false });
      assert.equal(r.error, null);
      assert.match(r.text, /^原来的设定\n\n/);
      assert.match(r.text, /没有读文件/);
      assert.match(r.text, /不要输出 <invoke>/);
      assert.match(r.text, /读不到/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
