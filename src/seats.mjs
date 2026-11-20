// 实时圆桌的席位配置与 CLI 适配层：
// Opus / Fable 走 claude -p（订阅，流式），GPT 走 codex exec（默认 service_tier="priority"），Gemini 走 agy（Antigravity CLI）。
// 零第三方依赖；仅通过文件系统检测可用 CLI，不启动子进程探测。
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// 每个 CLI 怎么装、怎么登录。自检和 --doctor 用它给出能照着做的下一步。
// install / login 是给人读的一句话；installCmd / loginCmd 是其中要在终端敲的命令，网页里会显示成代码样式。
export const CLI_SETUP = {
  claude: {
    name: 'Claude Code CLI',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    install: '在终端运行 npm install -g @anthropic-ai/claude-code',
    loginCmd: 'claude',
    login: '在终端运行 claude，输入 /login，按提示用 Claude 账号登录',
  },
  codex: {
    name: 'OpenAI Codex CLI',
    installCmd: 'npm install -g @openai/codex',
    install: '在终端运行 npm install -g @openai/codex',
    loginCmd: 'codex login',
    login: '在终端运行 codex login，按提示用 ChatGPT 账号登录',
    minVersion: '0.169',
  },
  agy: {
    name: 'Antigravity CLI（agy）',
    installCmd: null,
    install: '安装 Google Antigravity，并按它的说明装好 agy 命令行',
    loginCmd: 'agy',
    login: '在终端运行一次 agy，按提示用 Google 账号登录',
  },
};

/**
 * 把 CLI 的报错归成几类，并给出下一步怎么做。
 * kind：login 没登录 / model 账号用不了这个模型 / version 命令行版本太旧 / network 网络不通 / timeout 超时 / other 其他
 */
export function classifyError(cli, message) {
  const msg = String(message ?? '');
  const setup = CLI_SETUP[cli] ?? {};
  if (/not logged in|please run \/login|\b401\b|unauthori[sz]ed|missing bearer|authentication (failed|interrupted)|invalid api key|not authenticated|login required|oauth/i.test(msg)) {
    return { kind: 'login', reason: '没有登录', fix: setup.login ?? `先登录 ${cli}` };
  }
  if (/not supported when using|issue with the selected model|not supported for model|invalid model|unknown model|model .*(not found|does not exist|not available)|do(es)? not have access to (the )?model|may not have access/i.test(msg)) {
    return { kind: 'model', reason: '账号用不了这个模型', fix: '改用账号默认模型，或在 seats.json 里换一个模型名' };
  }
  if (/unexpected argument|unrecognized (option|argument)|unknown (flag|option|argument)|flag provided but not defined|invalid value .* for '--/i.test(msg)) {
    return { kind: 'version', reason: '命令行版本太旧', fix: `升级 ${setup.name ?? cli}${setup.minVersion ? `（需要 ${setup.minVersion} 及以上）` : ''}：${setup.install ?? ''}` };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|fetch failed|stream disconnected|could not resolve|connection (refused|reset|error)/i.test(msg)) {
    return { kind: 'network', reason: '连不上服务', fix: '检查网络或代理设置，确认在这台电脑的终端里能正常使用这个命令行' };
  }
  if (/超时|timed? ?out/i.test(msg)) {
    return { kind: 'timeout', reason: '等太久没有回复', fix: '网络慢或服务繁忙，稍后再测一次' };
  }
  if (/\b(429|500|502|503|529)\b|overloaded|rate.?limit|too many requests|temporarily|try again|backend returned|internal (server )?error|service unavailable/i.test(msg)) {
    return { kind: 'transient', reason: '服务暂时出错', fix: '服务那边的临时问题，稍后再测一次' };
  }
  return { kind: 'other', reason: '调用失败', fix: '把下面的原始报错复制给项目作者' };
}

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

const NO_TOOLS = '不要使用任何工具，也不要读写文件，直接用文字回答。提问人只给了文件路径而没贴内容时，直接说读不到，请他把内容贴进来。';
// Claude 席位用 --tools "" 关掉了工具，但模型不知道；拿到路径时它可能把工具调用写成正文，所以在系统提示里讲明
const claudeNoTools = web => web
  ? '除了上网搜索，你在这里没有读文件、运行命令的工具，不要输出 <invoke> 之类的工具调用标记。提问人只给了本地文件路径而没贴内容时，直接说读不到，请他把内容贴进来或用「附件」加进来。'
  : '你在这里没有读文件、上网、运行命令的工具，不要输出 <invoke> 之类的工具调用标记。提问人只给了文件路径或链接而没贴内容时，直接说读不到，请他把内容贴进来或用「附件」加进来。';

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
      '--system-prompt', `${system}\n\n${claudeNoTools(web)}`,
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

/** 用一个席位的配置（可以是临时改过模型的副本）调一次对应的 CLI。 */
export function runSeat(seat, opts, findBinFn = findBin) {
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
}

export function createSay({ seats, findBinFn = findBin } = {}) {
  const table = seats ?? DEFAULT_SEATS;
  return function say(seatId, opts) {
    const seat = table[seatId];
    if (!seat) throw new Error(`没有这个席位：${seatId}`);
    return runSeat(seat, opts, findBinFn);
  };
}

const PROBE_SYS = '这是一次连通性测试。';
const PROBE_PROMPT = '只回复两个字：收到';
export const PROBE_TIMEOUT_MS = 120_000;

/**
 * 真的给一个席位发一句很短的话，看它能不能回。
 * 账号用不了配置的模型时，自动再试一次账号默认模型（model 留空）。
 * 返回 { ok, kind, reason, fix, detail, model, fallbackFrom, ms }：
 * - ok 且 fallbackFrom 有值：原模型用不了，账号默认模型能用
 * - kind 为 missing：没装这个命令行
 */
export async function probeSeat(seat, { findBinFn = findBin, runFn = runSeat, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const setup = CLI_SETUP[seat.cli] ?? {};
  if (!findBinFn(seat.cli)) {
    return {
      ok: false,
      kind: 'missing',
      reason: `没装 ${setup.name ?? seat.cli}`,
      fix: setup.install ? `${setup.install}；装好后${setup.login ?? '登录'}` : (seat.hint || CLI_HINTS[seat.cli] || `安装 ${seat.cli}`),
      detail: '',
      model: seat.model ?? '',
    };
  }
  const attempt = async model => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    try {
      const r = await runFn({ ...seat, model }, { system: PROBE_SYS, prompt: PROBE_PROMPT, effort: 'low', fast: false, web: false, signal: ac.signal }, findBinFn);
      if (timedOut) return { ...r, error: `超时：${Math.round(timeoutMs / 1000)} 秒没有回复` };
      if (!r.error && !String(r.text ?? '').trim()) return { ...r, error: '没有返回任何内容' };
      return r;
    } finally {
      clearTimeout(timer);
    }
  };
  const t0 = Date.now();
  const model = seat.model ?? '';
  let first = await attempt(model);
  // 偶发的服务端错误、网络抖动、说不清的错误，再试一次，免得误报
  if (first.error && ['transient', 'network', 'other'].includes(classifyError(seat.cli, first.error).kind)) first = await attempt(model);
  if (!first.error) return { ok: true, kind: 'ok', reason: '', fix: '', detail: '', model, ms: Date.now() - t0 };
  const c = classifyError(seat.cli, first.error);
  if (c.kind === 'model' && model) {
    const second = await attempt('');
    if (!second.error) {
      return {
        ok: true,
        kind: 'fallback',
        reason: `账号用不了 ${model}`,
        fix: '已改用账号默认模型',
        detail: String(first.error).slice(0, 400),
        model: '',
        fallbackFrom: model,
        ms: Date.now() - t0,
      };
    }
    const c2 = classifyError(seat.cli, second.error);
    return { ok: false, ...c2, detail: String(second.error).slice(0, 400), model, ms: Date.now() - t0 };
  }
  return { ok: false, ...c, detail: String(first.error).slice(0, 400), model, ms: Date.now() - t0 };
}

/**
 * 模型回退记录：<dataDir>/model-fallbacks.json，{ 席位: { from: 原模型, to: 改用的模型, at } }。
 * 只在席位当前配置的模型仍是 from 时生效；改了 seats.json 里的模型名，旧记录自动失效。
 */
export function fallbacksPath(dataDir) {
  return join(dataDir, 'model-fallbacks.json');
}

export function readFallbacks(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(fallbacksPath(dataDir), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function writeFallbacks(dataDir, data) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(fallbacksPath(dataDir), `${JSON.stringify(data, null, 2)}\n`);
}

export function applyFallbacks(seats, fallbacks) {
  for (const [id, fb] of Object.entries(fallbacks ?? {})) {
    const seat = seats[id];
    if (!seat || !fb || typeof fb !== 'object') continue;
    const original = seat.fallbackFrom ?? seat.model;
    if (original !== fb.from) continue;
    seat.fallbackFrom = fb.from;
    seat.model = fb.to ?? '';
  }
  return seats;
}

/**
 * 测一个席位并把回退结果落盘、改到 seats 上：
 * 先按原模型测（之前回退过的也先试原模型，能用了就恢复）。
 */
export async function probeAndApply(id, seats, dataDir, opts = {}) {
  const seat = seats[id];
  if (!seat) return { ok: false, kind: 'other', reason: '没有这个席位', fix: '', detail: '' };
  const original = seat.fallbackFrom ?? seat.model ?? '';
  const result = await probeSeat({ ...seat, model: original }, opts);
  const fbs = readFallbacks(dataDir);
  let changed = false;
  if (result.ok && result.fallbackFrom) {
    seat.fallbackFrom = result.fallbackFrom;
    seat.model = '';
    fbs[id] = { from: result.fallbackFrom, to: '', at: new Date().toISOString() };
    changed = true;
  } else if (result.ok && seat.fallbackFrom) {
    seat.model = seat.fallbackFrom;
    delete seat.fallbackFrom;
    if (fbs[id]) { delete fbs[id]; changed = true; }
  }
  if (changed) writeFallbacks(dataDir, fbs);
  return { ...result, at: new Date().toISOString() };
}

export const say = createSay({ seats: DEFAULT_SEATS, findBinFn: findBin });
