// 实时圆桌的席位配置与 CLI 适配层：
// Opus / Fable 走 claude -p（订阅，流式），GPT 走 codex exec（默认 service_tier="priority"），Gemini 走 agy（Antigravity CLI）。
// 零第三方依赖；仅通过文件系统检测可用 CLI，不启动子进程探测。
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';

export const DEFAULT_SEATS = {
  opus: {
    vendor: 'anthropic',
    cli: 'claude',
    model: 'claude-opus-5-5',
    label: 'Opus 5.5',
    defaultEffort: 'high',
    color: '#c2581e',
    darkColor: '#f0915a',
  },
  fable: {
    vendor: 'anthropic',
    cli: 'claude',
    model: 'claude-fable-5-2',
    label: 'Fable 5.2',
    defaultEffort: 'high',
    color: '#a3367a',
    darkColor: '#e47fbd',
  },
  astra: {
    vendor: 'openai',
    cli: 'codex',
    model: 'gpt-6.2-astra',
    label: 'GPT-6.2 astra',
    defaultEffort: 'high',
    color: '#1f7a4d',
    darkColor: '#5fcf95',
  },
  sol: {
    vendor: 'openai',
    cli: 'codex',
    model: 'gpt-6.2-sol',
    label: 'GPT-6.2 sol',
    defaultEffort: 'xhigh',
    color: '#2b5fb3',
    darkColor: '#7ea7ee',
  },
  gemini: {
    vendor: 'google',
    cli: 'agy',
    model: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    defaultEffort: 'high',
    color: '#6d4bd8',
    darkColor: '#a993f5',
  },
  carbon: {
    vendor: 'google',
    cli: 'agy',
    model: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    defaultEffort: 'high',
    color: '#4b5866',
    darkColor: '#a9b6c4',
  },
};

export const CLI_HINTS = {
  claude: '未检测到 claude 命令（需安装 Claude Code CLI 并登录）',
  codex: '未检测到 codex 命令（需安装 OpenAI Codex CLI 并登录）',
  agy: '未检测到 agy 命令（需安装 Antigravity CLI 并登录）',
};

const VENDOR_CLI = { anthropic: 'claude', openai: 'codex', google: 'agy' };
const CLI_VENDOR = { claude: 'anthropic', codex: 'openai', agy: 'google' };

let emptyDir = null;
function getEmptyDir() {
  if (!emptyDir || !existsSync(emptyDir)) {
    emptyDir = mkdtempSync(join(tmpdir(), 'live-roundtable-')); // 空目录当 cwd，免得读到当前仓库里的 AGENTS.md / CLAUDE.md
  }
  return emptyDir;
}

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 纯文件系统命令查找：绝不 spawn `<cli> --help / --version`，避免部分 CLI 包装器弹窗或挂起。
 */
export function findBin(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? (/\.(cmd|exe|bat)$/i.test(cmd) ? [cmd] : [`${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`, cmd])
    : [cmd];

  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes(sep)) {
    for (const c of candidates) {
      if (isExecutableFile(c)) return c;
    }
    return null;
  }

  const dirs = [];
  const seen = new Set();
  const pushDir = d => {
    if (d && !seen.has(d)) {
      seen.add(d);
      dirs.push(d);
    }
  };

  for (const d of (process.env.PATH || '').split(delimiter)) pushDir(d);
  if (!isWin) {
    pushDir(join(homedir(), '.local', 'bin'));
    pushDir('/opt/homebrew/bin');
    pushDir('/usr/local/bin');
  }

  for (const dir of dirs) {
    for (const name of candidates) {
      const full = join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * 按优先级加载席位配置：
 * 1. 显式指定的 seatsFile（--seats-file 或 ROUNDTABLE_SEATS）
 * 2. <dataDir>/seats.json
 * 3. <repoRoot>/seats.json
 */
export function loadSeats({ seatsFile, dataDir, repoRoot } = {}) {
  let configPath = null;
  if (seatsFile) {
    if (!existsSync(seatsFile)) throw new Error(`找不到席位配置文件：${seatsFile}`);
    configPath = seatsFile;
  } else {
    const candidates = [
      dataDir ? join(dataDir, 'seats.json') : null,
      repoRoot ? join(repoRoot, 'seats.json') : null,
    ].filter(Boolean);
    configPath = candidates.find(p => existsSync(p)) ?? null;
  }

  const seats = Object.fromEntries(
    Object.entries(DEFAULT_SEATS).map(([id, s]) => [id, { ...s }]),
  );

  if (!configPath) return { seats, configPath: null };

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`席位配置文件解析失败（${configPath}）：${e.message}`);
  }

  const patch = raw && typeof raw === 'object' && raw.seats && typeof raw.seats === 'object' && !Array.isArray(raw.seats)
    ? raw.seats
    : raw;

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`席位配置文件格式不正确（${configPath}）：应为对象或包含 seats 对象`);
  }

  for (const [id, val] of Object.entries(patch)) {
    if (id.startsWith('$') || id.startsWith('_')) continue;
    if (val === false || val === null) {
      delete seats[id];
      continue;
    }
    if (typeof val !== 'object' || Array.isArray(val)) continue;
    const base = seats[id];
    if (base) {
      const merged = { ...base, ...val };
      if (val.cli && !val.vendor && CLI_VENDOR[val.cli]) merged.vendor = CLI_VENDOR[val.cli];
      if (val.vendor && !val.cli && VENDOR_CLI[val.vendor]) merged.cli = VENDOR_CLI[val.vendor];
      seats[id] = merged;
    } else {
      const cli = val.cli || VENDOR_CLI[val.vendor] || 'claude';
      const vendor = val.vendor || CLI_VENDOR[cli] || 'anthropic';
      seats[id] = {
        vendor,
        cli,
        model: val.model ?? '',
        label: val.label || id,
        defaultEffort: val.defaultEffort || 'high',
        color: val.color || '#2f5d50',
        darkColor: val.darkColor || '#8cc7b4',
        ...val,
        vendor,
        cli,
      };
    }
  }

  return { seats, configPath };
}

export function inspectSeats(seats, findBinFn = findBin) {
  const cache = new Map();
  const resolve = cli => {
    if (!cache.has(cli)) cache.set(cli, findBinFn(cli));
    return cache.get(cli);
  };
  const out = {};
  for (const [id, seat] of Object.entries(seats)) {
    const bin = resolve(seat.cli);
    const available = Boolean(bin);
    const hint = available ? '' : (seat.hint || CLI_HINTS[seat.cli] || `未检测到 ${seat.cli} 命令`);
    out[id] = { ...seat, available, bin, hint };
  }
  return out;
}

const IDLE_MS = 150_000;
const GEMINI_IDLE_MS = 360_000;
const idleMs = seat => (seat.vendor === 'google' ? GEMINI_IDLE_MS : IDLE_MS);

async function retryStalled(once, bin, seat, opts) {
  const s = idleMs(seat) / 1000;
  const r = await once(bin, seat, opts);
  if (!r.stalled || opts.signal?.aborted) return r;
  opts.onStatus?.(`超过 ${s} 秒没动静，重试一次`);
  const r2 = await once(bin, seat, opts);
  r2.ms += r.ms;
  if (r2.stalled) r2.error = `连续两次超过 ${s} 秒没动静，放弃`;
  return r2;
}

const stop = p => {
  if (p.exitCode !== null || p.signalCode !== null || p.stopping) return;
  p.stopping = true;
  if (process.platform === 'win32') {
    try { p.kill(); } catch {}
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) {
        try { p.kill('SIGKILL'); } catch {}
      }
      p.stdout?.destroy();
      p.stderr?.destroy();
    }, 10_000).unref();
    return;
  }
  p.kill('SIGTERM');
  setTimeout(() => {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    p.stdout?.destroy();
    p.stderr?.destroy();
  }, 10_000).unref();
};

function spawnCli(bin, args, opts) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const quote = a => (/[ \t"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    return spawn(quote(bin), args.map(quote), { ...opts, shell: true, windowsVerbatimArguments: false });
  }
  return spawn(bin, args, opts);
}

const NO_TOOLS = '不要使用任何工具，也不要读写文件，直接用文字回答。';

function claudeOnce(bin, seat, { system, prompt, web = false, effort = 'high', fast = true, signal, onDelta = () => {}, onStatus = () => {} }) {
  return new Promise(ok => {
    const t0 = performance.now();
    const res = { text: '', ms: 0, usage: { in: 0, cacheRead: 0, out: 0 }, usd: 0, speed: 'standard', sources: [], searches: [], error: null };
    const tools = web ? 'WebSearch,WebFetch' : '';
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      ...(seat.model ? ['--model', seat.model] : []),
      '--effort', effort,
      '--tools', tools, ...(web ? ['--allowedTools', tools] : []),
      '--no-session-persistence', '--permission-mode', 'dontAsk', '--safe-mode',
      '--system-prompt', system,
      ...(fast ? ['--settings', '{"fastMode":true}'] : []),
    ];
    const p = spawnCli(bin, args, { cwd: getEmptyDir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '', streamed = '', last = Date.now(), thinking = false;
    const idle = setInterval(() => { if (Date.now() - last > idleMs(seat)) { res.stalled = true; stop(p); } }, 5000);
    const onLine = line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'system' && m.subtype === 'init') {
        res.speed = m.fast_mode_state === 'on' ? 'fast' : 'standard';
        if (fast && m.fast_mode_state !== 'on') onStatus(`fast mode 没开（${m.fast_mode_disabled_reason ?? '未说明'}），用标准速度`);
      }
      if (m.type === 'stream_event' && m.event?.delta?.type === 'thinking_delta' && !thinking) { thinking = true; onStatus('正在思考'); }
      if (m.type === 'stream_event' && m.event?.type === 'content_block_start' && m.event.content_block?.type === 'text') thinking = false;
      if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') { streamed += m.event.delta.text; onDelta(m.event.delta.text); }
      if (m.type === 'stream_event' && m.event?.type === 'message_stop' && streamed && !streamed.endsWith('\n')) { streamed += '\n\n'; onDelta('\n\n'); }
      if (m.type === 'assistant') for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use' && b.name === 'WebSearch') { res.searches.push(b.input?.query); onStatus(`搜索：${b.input?.query ?? ''}`); }
        if (b.type === 'tool_use' && b.name === 'WebFetch') { onStatus(`打开：${b.input?.url ?? ''}`); if (b.input?.url && !res.sources.some(s => s.url === b.input.url)) res.sources.push({ url: b.input.url }); }
      }
      if (m.type === 'user') for (const b of m.message?.content ?? []) if (b.type === 'tool_result') {
        const txt = typeof b.content === 'string' ? b.content : (b.content ?? []).map(c => c.text ?? '').join('\n');
        for (const [, title, url] of txt.matchAll(/\{"title":"((?:[^"\\]|\\.)*)","url":"([^"]+)"\}/g)) if (!res.sources.some(s => s.url === url)) res.sources.push({ url, title });
      }
      if (m.type === 'result') {
        const u = m.usage ?? {};
        res.usage = { in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cacheRead: u.cache_read_input_tokens ?? 0, out: u.output_tokens ?? 0 };
        if (u.speed) res.speed = u.speed;
        res.text = m.result ?? streamed;
        if (m.is_error || m.subtype !== 'success') res.error = String(m.result ?? m.subtype).slice(0, 400);
      }
    };
    p.on('error', e => { res.error = `启动 ${bin} 失败：${e.message}`; });
    p.stdout.on('data', d => { last = Date.now(); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.stderr.on('data', d => (err = (err + d).slice(-2000)));
    const kill = () => stop(p);
    signal?.addEventListener('abort', kill, { once: true });
    p.on('close', code => {
      clearInterval(idle);
      signal?.removeEventListener('abort', kill);
      if (buf) onLine(buf);
      if (!res.text) res.text = streamed.trim();
      if (signal?.aborted) res.error = '已停止';
      else if (!res.text && !res.error) res.error = `claude exit ${code}: ${err.slice(-300)}`;
      res.ms = Math.round(performance.now() - t0);
      ok(res);
    });
    p.stdin.end(prompt);
  });
}

function codex(bin, seat, { system, prompt, web = false, effort = 'high', fast = true, signal, onStatus = () => {} }) {
  return new Promise(ok => {
    const t0 = performance.now();
    const args = [
      ...(web ? ['--search'] : []),
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config',
      ...(seat.model ? ['-m', seat.model] : []),
      '-c', `model_reasoning_effort="${effort}"`,
      ...(fast ? ['-c', 'service_tier="priority"'] : []),
      '-s', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'multi_agent', '-',
    ];
    const env = { ...process.env };
    for (const k of ['CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_MCP_NODE_PATH']) delete env[k];
    // codex 的系统提示换不掉，角色说明放在用户消息最前面
    const body = [`【你的设定】\n${system}`, !web && NO_TOOLS, prompt].filter(Boolean).join('\n\n');
    const p = spawnCli(bin, args, { cwd: getEmptyDir(), stdio: ['pipe', 'pipe', 'pipe'], env });
    const res = { text: '', ms: 0, usage: null, usd: 0, speed: fast ? 'priority' : 'default', sources: [], searches: [], error: null };
    const said = [];
    let buf = '', err = '';
    const onLine = line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'item.completed' && m.item?.type === 'agent_message') said.push(m.item.text);
      if (m.type === 'item.completed' && m.item?.type === 'web_search') {
        const a = m.item.action ?? {};
        if (a.type === 'open_page' && a.url) { res.sources.push({ url: a.url }); onStatus(`打开：${a.url}`); }
        else for (const q of a.queries ?? [a.query ?? m.item.query].filter(Boolean)) { res.searches.push(q); onStatus(`搜索：${q}`); }
      }
      if (m.type === 'turn.completed') res.usage = { in: m.usage.input_tokens, cacheRead: m.usage.cached_input_tokens ?? 0, out: m.usage.output_tokens };
      if (m.type === 'error' || m.type === 'turn.failed') res.error = (m.message ?? m.error?.message ?? line).slice(0, 400);
    };
    p.on('error', e => { res.error = `启动 ${bin} 失败：${e.message}`; });
    p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.stderr.on('data', d => (err = (err + d).slice(-2000)));
    const kill = () => stop(p);
    signal?.addEventListener('abort', kill, { once: true });
    p.on('close', code => {
      signal?.removeEventListener('abort', kill);
      if (buf) onLine(buf);
      res.text = web ? (said.at(-1) ?? '') : said.join('\n');
      if (signal?.aborted) res.error = '已停止';
      else if (!res.text && !res.error) res.error = `codex exit ${code}: ${err.slice(-300)}`;
      res.ms = Math.round(performance.now() - t0);
      ok(res);
    });
    p.stdin.end(body);
  });
}

const AGY_MAX = 175_000;
const AGY_EFFORT = e => (['low', 'medium', 'high'].includes(e) ? e : 'high');

function geminiOnce(bin, seat, { system, prompt, web = false, effort = 'high', signal, onDelta = () => {}, onStatus = () => {} }) {
  return new Promise(ok => {
    const t0 = performance.now();
    const res = { text: '', ms: 0, usage: { in: 0, cacheRead: 0, out: 0 }, usd: 0, speed: 'standard', sources: [], searches: [], error: null };
    const head = [`【你的设定】\n${system}`, web ? '上网只用 search_web 和 read_url_content，不要读写文件、不要运行命令。' : NO_TOOLS].join('\n\n');
    let rest = prompt;
    const room = AGY_MAX - Buffer.byteLength(head) - 200;
    if (Buffer.byteLength(rest) > room) {
      while (Buffer.byteLength(rest) > room) rest = rest.slice(Math.ceil((Buffer.byteLength(rest) - room) / 3) + 1);
      rest = `（前面的讨论记录太长，开头被省略了）\n…${rest}`;
      onStatus('记录太长，开头被省略');
    }
    const body = `${head}\n\n${rest}`;
    const args = [
      ...(seat.model ? ['--model', seat.model] : []),
      '--effort', AGY_EFFORT(effort), '--sandbox', '--output-format', 'stream-json', '--disable-slash-commands', '-p', body,
    ];
    const p = spawnCli(bin, args, { cwd: getEmptyDir(), stdio: ['ignore', 'pipe', 'pipe'] });
    const steps = new Map();
    let buf = '', err = '', last = Date.now(), lastStep = -1;
    const idle = setInterval(() => { if (Date.now() - last > idleMs(seat)) { res.stalled = true; stop(p); } }, 5000);
    const onLine = line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const s = m.step_update;
      if (s?.step_type === 'agent_response' && s.text_delta) {
        if (lastStep >= 0 && s.step_index !== lastStep && steps.get(lastStep)) onDelta('\n\n');
        lastStep = s.step_index;
        steps.set(s.step_index, (steps.get(s.step_index) ?? '') + s.text_delta);
        onDelta(s.text_delta);
      }
      if (s?.step_type === 'tool' && s.state === 'ACTIVE') {
        const a = s.tool_info?.parameters ?? {};
        if (s.tool_name === 'search_web') { res.searches.push(a.query); onStatus(`搜索：${a.query ?? ''}`); }
        else if (s.tool_name === 'read_url_content') { const url = a.Url ?? a.url; onStatus(`打开：${url ?? ''}`); if (url && !res.sources.some(x => x.url === url)) res.sources.push({ url }); }
        else onStatus(`调用 ${s.tool_name}`);
      }
      if (s?.usage) { res.usage.in += s.usage.input_tokens ?? 0; res.usage.cacheRead += s.usage.cache_read_tokens ?? 0; res.usage.out += s.usage.output_tokens ?? 0; }
      if (m.event === 'result') {
        const r = m.result ?? {};
        if (r.status !== 'SUCCESS') res.error = String(r.error ?? r.status).slice(0, 400);
        if (r.denied_actions?.length) onStatus(`被拒的工具：${r.denied_actions.map(d => d.action).join('、')}`);
      }
    };
    p.on('error', e => { res.error = `启动 ${bin} 失败：${e.message}`; });
    p.stdout.on('data', d => { last = Date.now(); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.stderr.on('data', d => (err = (err + d).slice(-2000)));
    const kill = () => stop(p);
    signal?.addEventListener('abort', kill, { once: true });
    p.on('close', code => {
      clearInterval(idle);
      signal?.removeEventListener('abort', kill);
      if (buf) onLine(buf);
      res.text = (steps.get(lastStep) ?? '').trim();
      if (signal?.aborted) res.error = '已停止';
      else if (!res.text && !res.error) res.error = `agy exit ${code}: ${err.replace(/^ERROR: logging before google\.Init.*$/gm, '').trim().slice(-300)}`;
      res.ms = Math.round(performance.now() - t0);
      ok(res);
    });
  });
}

const claude = (bin, seat, opts) => retryStalled(claudeOnce, bin, seat, opts);
const gemini = (bin, seat, opts) => retryStalled(geminiOnce, bin, seat, opts);

export function createSay({ seats, findBinFn = findBin } = {}) {
  const table = seats ?? DEFAULT_SEATS;
  return function say(seatId, opts) {
    const seat = table[seatId];
    if (!seat) throw new Error(`没有这个席位：${seatId}`);
    const bin = findBinFn(seat.cli);
    if (!bin) {
      return Promise.resolve({
        text: '',
        ms: 0,
        usage: null,
        usd: 0,
        speed: 'standard',
        sources: [],
        searches: [],
        error: seat.hint || CLI_HINTS[seat.cli] || `未找到命令 ${seat.cli}`,
      });
    }
    if (seat.vendor === 'anthropic') return claude(bin, seat, opts);
    if (seat.vendor === 'google') return gemini(bin, seat, opts);
    return codex(bin, seat, opts);
  };
}

export const say = createSay({ seats: DEFAULT_SEATS, findBinFn: findBin });
