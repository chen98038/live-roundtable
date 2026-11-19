// 实时圆桌服务端：提供 HTTP API 与 SSE 事件流，支持自定义席位与动态主持人。
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFallbacks, CLI_SETUP, createSay, findBin, inspectSeats, loadSeats, probeAndApply, readFallbacks, runSeat } from './seats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

const bytes = s => Buffer.byteLength(s);
const GEMINI_MAX = 170_000;
// 随项目分发的字体（子集化 woff2，见 vendor/fonts/README.md），只放行这两个文件
const FONTS = new Set(['/vendor/fonts/Montserrat-subset.woff2', '/vendor/fonts/NotoSansSC-subset.woff2']);

const SUMMARY_SYS = '你是这场讨论的中立主持人，用中文。不站队，不替任何一方补论据。';
const summaryPrompt = (c, whoFn) => `# 讨论记录\n\n${transcript(c, Infinity, whoFn)}\n\n# 请整理\n针对提问人最新的问题，用这几个小标题：\n## 回答\n综合大家的讨论直接回答提问人，3–6 句。有分歧时说清倾向哪边、为什么，或者取决于什么。\n## 共识\n## 分歧（谁持什么立场、理由；标出分歧来自判断标准、事实还是对未来的预测）\n## 关键事实（谁提出、有没有查证；冲突的标出来）\n## 还需要提问人回答或决定的问题\n## 下一层问题\n一句话：顺着这次的结论往下，提问人接下来最该让大家讨论的一个问题，写成能直接拿去问的话。\n## 深挖这处分歧\n一句话：针对上面最要紧的那处分歧，让大家把它讲透的一个问题，写成能直接拿去问的话。没有实质分歧就写「无」。\n简洁，总共不超过 900 字。`;

const FOCUS_SYS = '你是这场讨论的主持人，用中文。不站队，不发表自己的观点，只负责让讨论往深处走。';
const focusPrompt = (c, whoFn) => `# 讨论记录\n\n${transcript(c, Infinity, whoFn)}\n\n# 你的任务\n大家刚说完一轮。找出最新一轮里对回答提问人的问题最要紧的那一处分歧，判断它属于哪一种：判断标准不同、事实不同、还是对未来的预测不同。然后给下一轮提一个问题，逼大家正面回答这处分歧（标准不同就问该用哪个标准、为什么；事实不同就问证据；预测不同就问什么信号能分出对错）。\n格式，总共不超过 150 字：\n**核心分歧**：谁和谁在什么上不同（属于哪一种）\n**这轮请回答**：一个具体的问题\n如果已经没有实质分歧、再讨论只会重复，只写一行「【无分歧】」加一句原因。`;

const PREPARE_SYS = '你是圆桌讨论的策划主持人。在正式开聊前，根据提问人的问题起草简洁的背景约束，并为每位参加的席位分配彼此互补、有张力的角色视角。不要直接回答问题，只输出严格合法的 JSON。';
function preparePrompt(c, text, targetSeats, seatsMap) {
  const existingBg = c.settings.background?.trim();
  const existingPersonas = targetSeats
    .map(id => [id, c.settings.personas?.[id]?.trim()])
    .filter(([, p]) => p);
  const seatList = targetSeats.map(id => `- ${id}（${seatsMap[id]?.label ?? id}）`).join('\n');
  return [
    `# 提问人的问题\n${text}`,
    existingBg && `# 提问人已写好的背景（请保留其中的事实和约束，在此基础上补全整理）\n${existingBg}`,
    existingPersonas.length && `# 已有角色设定（可保留或优化）\n${existingPersonas.map(([id, p]) => `- ${id}：${p}`).join('\n')}`,
    `# 参加本场圆桌的席位\n${seatList}`,
    `# 你的任务
只输出一个严格合法的 JSON 对象（不要加解释说明）：
{
  "background": "精炼的背景与约束（80–250 字，分条写出目标、现状前提、关键边界；对明显缺失且会影响结论的信息，用「【待补充：……】」标出）",
  "personas": {
    ${targetSeats.map(id => `"${id}": "15–45 字的角色设定：明确该席位代表的视角、判断标准或负责挑哪类刺"`).join(',\n    ')}
  },
  "missing": [
    "开聊前最值得提问人补充的 1–3 个关键事实或约束（每条不超过 25 字）"
  ]
}

要求：
1. personas 的 key 必须严格使用上面的席位 id，内容里不要写模型名字。
2. 各位角色必须彼此错开、形成有价值的张力（例如：实操落地、反方挑刺/风险、成本与回报、长期/第一性原理、用户/一线视角等），不要让角色趋同。
3. 不要直接回答提问人的问题，只做讨论前的背景梳理和角色分工。
4. 默认用中文（除非提问人用其他语言提问）。`,
  ].filter(Boolean).join('\n\n');
}

function parsePrepareOutput(raw, targetSeats) {
  const txt = String(raw ?? '').trim();
  const candidates = [txt];
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = txt.indexOf('{');
  const lastBrace = txt.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(txt.slice(firstBrace, lastBrace + 1));

  let parsed = null;
  for (const s of candidates) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        parsed = v;
        break;
      }
    } catch {}
  }
  if (!parsed) return { error: '主持人返回的内容不是有效 JSON，请重试' };

  const background = typeof parsed.background === 'string' ? parsed.background.trim() : '';
  const personas = {};
  if (parsed.personas && typeof parsed.personas === 'object' && !Array.isArray(parsed.personas)) {
    const allowed = new Set(targetSeats);
    for (const [k, v] of Object.entries(parsed.personas)) {
      if (allowed.has(k) && typeof v === 'string' && v.trim()) personas[k] = v.trim();
    }
  }
  const missing = Array.isArray(parsed.missing)
    ? parsed.missing.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 4)
    : [];

  if (!background && !Object.keys(personas).length) {
    return { error: '主持人没有生成有效的背景或角色，请重试' };
  }
  return { background, personas, missing };
}

const kindOf = c => {
  const u = c.messages.findLast(m => m.role === 'user');
  return u?.kind ?? (u?.rank ? 'rank' : null);
};

const FOCUS_FORMAT = '格式，总共不超过 150 字：\n**核心分歧**：谁和谁在什么上不同（属于哪一种）\n**这轮请回答**：一个具体的问题';
const NEXT_SECTIONS = '## 下一层问题\n一句话：提问人接下来最该让大家讨论的问题，写成能直接拿去问的话。\n## 深挖这处分歧\n一句话：针对最要紧的那处分歧，写成能直接拿去问的话。没有实质分歧就写「无」。';
const RULERS = `三把尺：
- 贝叶斯：数据只按「谁把它预测得更准」重新分配信任。一个主张该让人更新多少，取决于证据的似然比：如果这个主张是错的，这些证据还会不会照样出现？故事、幸存者案例、事后解释，似然比接近 1，不算证据。
- 奥卡姆剃刀（最小描述长度）：好理论 = 好压缩，用最短的描述解释最多的现象。这本书真正独立的核心观点有几个？哪些只是换个说法重复？有没有更简单的解释（回归均值、幸存者偏差、选择效应、激励、运气）能解释同样的证据？
- 万有理论：把它并进更大的统一。它的观点能不能归到一个更一般的原理下，是哪个原理的特例？它把哪些原来分开的现象统一了？统一后多出什么新预测？它在哪里和其他成熟理论冲突，边界在哪？`;

function transcript(c, budget = Infinity, whoFn) {
  const ms = c.messages.filter(m => m.text && !m.error);
  const parts = ms.map(m => `【${whoFn(m)}】\n${m.text}`);
  const total = () => parts.reduce((s, p) => s + (p ? bytes(p) + 2 : 0), 0);
  const lastUser = ms.findLastIndex(m => m.role === 'user');
  for (let i = 0; i < lastUser && total() > budget; i++) {
    if (ms[i].role === 'user' || ms[i].role === 'summary') continue;
    let j = i;
    while (j < lastUser && ms[j].role !== 'user' && ms[j].role !== 'summary') j++;
    if (ms[j]?.role === 'summary') {
      parts.fill(null, i, j);
      parts[i] = `（这一段 ${j - i} 条发言已折叠，结论见下面的主持人总结）`;
    }
    i = j;
  }
  let dropped = 0;
  for (let i = 0; i < lastUser && total() > budget; i++) {
    if (parts[i]) {
      parts[i] = null;
      dropped++;
    }
  }
  return [dropped && `（更早的 ${dropped} 段记录太长，已省略）`, ...parts].filter(Boolean).join('\n\n');
}

const askerAndBackground = (c, whoFn) => `# 提问人的话\n\n${transcript(c, Infinity, whoFn)}${c.settings.background?.trim() ? `\n\n# 提问人给的背景\n\n${c.settings.background.trim()}` : ''}`;

const SPECIAL = {
  rank: {
    label: '找秩',
    inventorySys: '你是这场「找秩」讨论的主持人，用中文。这一步只列问题，不回答、不分类、不评论。',
    inventory: (c, whoFn) => `${askerAndBackground(c, whoFn)}\n\n# 你的任务\n这是一场「找秩」讨论：大家要从这件事下面的一大堆具体问题里，找出最少几个彼此独立的基本问题。第一步由你把具体问题倒出来，列成清单：\n- 编号 Q1、Q2……，15–40 条，每条一句问题。\n- 包括提问人原话和背景里提到或隐含的问题；你觉得他该问却没问的，放在最后，标「（补）」。\n- 不排序、不合并、不回答、不评论。只输出清单。`,
    ask: `这是一场「找秩」讨论：从一大堆具体问题里，找出最少几个彼此独立的基本问题（像矩阵的秩、一组基向量），其余问题都能由它们组合出来。主持人已经把具体问题列成清单（见记录，Q 编号）。请你：
1. 补漏：清单里漏掉的、你认为要紧的具体问题，最多 3 条，编号接着写；没有就写「无」。
2. 给出你的秩：几个，每个写成一句问题，编号 ①②③……
3. 证明独立：每个基本问题，去掉它，清单里哪几个 Q 就答不了。
4. 演示覆盖：清单里的 Q 各自由哪几个基本问题组合（写成「Q3 = ①+③」，可以成组写）。
5. 用三个原件校验：「提问人在哪两个选项之间决定」「他现在信什么、几成把握」「他能花多少注意力、时间、钱」，各落在你的哪个基本问题里；落不进去的说明为什么。
6. 零空间：哪些 Q 怎么答都不影响结果，可以定一次就交出去。
7. 一句话：这件事的核心矛盾，写成「在 A 和 B 之间，卡在 X 上」。
8. 每个基本问题，给一个两周内能看到的检验信号。
秩不是越多越好：能由别的推出来的就是冗余；分类分得整齐不算数。这次可以写到 700 字。`,
    respond: focused => `${focused ? '主持人刚指出各位的秩在哪里不同，并给这一轮提了一个问题（见记录最后一条）。请正面回答它' : '请对比其他人给出的秩'}：用反例（这几个都答好了，清单里哪个 Q 仍答不了）或冗余（哪个能由别的推出来、按什么规则）来说话，点名回应和你不同的人。你的秩有没有因此改变（加了、减了、合并了哪个），变了就直说，最后写出你现在的版本（每个一句问题）。不要重复你自己说过的话。`,
    focus: (c, whoFn) => `# 讨论记录\n\n${transcript(c, Infinity, whoFn)}\n\n# 你的任务\n这是一场「找秩」讨论，大家刚说完一轮。对比各位给出的基本问题，找出最要紧的一处分歧，判断它属于哪一种：个数不同（有人多一个或少一个）、切法不同（同一块被切成不同的问题）、还是覆盖不同（同一个 Q 被归到不同的基本问题）。然后给下一轮提一个问题，逼大家用反例或冗余来回答（比如：主张多一个的，给出其余都答好了、哪个 Q 仍答不了；主张少一个的，写出它由哪几个组合、按什么规则）。\n${FOCUS_FORMAT}\n如果各位的秩已经基本一致、再讨论只会重复，只写一行「【无分歧】」加一句原因。`,
    summary: (c, whoFn) => `# 讨论记录\n\n${transcript(c, Infinity, whoFn)}\n\n# 请整理\n这是一场「找秩」讨论。综合大家的讨论（以讨论后的版本为准），用这几个小标题：\n## 秩\n共识的基本问题：几个，每个一句问题，编号 ①②③。有争议的单独标出谁主张加、谁主张减。\n## 为什么是这几个\n每个基本问题：去掉它，哪几个 Q 就答不了。\n## 覆盖\n清单里的 Q 各自由哪几个基本问题组合，紧凑地写（「Q1、Q4、Q9 = ①」「Q3 = ①+③」）。仍然答不了的 Q 单独标出来。\n## 零空间\n怎么答都不影响结果、可以定一次就交出去的 Q。\n## 一句话\n这件事的核心矛盾：「在 A 和 B 之间，卡在 X 上」。\n## 先回答哪一个\n最该先回答的基本问题：它最不确定、又最能改变决定。说清为什么，以及提问人自己能怎么回答它。\n## 检验信号\n每个基本问题，两周内什么信号说明找错了。\n## 仍有分歧（谁持什么立场；标出是个数、切法还是覆盖的分歧）\n## 还需要提问人回答的问题（包括请他自己给几成把握的）\n${NEXT_SECTIONS}\n总共不超过 1200 字。`,
  },
  book: {
    label: '三把尺读书',
    inventorySys: '你是这场「三把尺读书」讨论的主持人，用中文。这一步只把书的观点列成清单，不评价、不排序。',
    inventory: (c, whoFn) => `${askerAndBackground(c, whoFn)}\n\n# 你的任务\n这是一场「三把尺读书」：大家要用贝叶斯、奥卡姆剃刀、万有理论三把尺重新梳理提问人说的这本书。第一步由你把书的观点列成清单：\n- 编号 C1、C2……，8–20 条。每条写成一句可以被证伪的主张（「X 导致 Y」「做 A 比 B 更能……」），不要写成口号。\n- 每条后面括号标书里主要靠什么支撑：数据 / 实验 / 案例 / 个人经历 / 推理 / 引用权威。\n- 以提问人贴的内容为准；他没贴、你凭对这本书的了解补的，标「据我所知」。不认识这本书就只按他贴的列，并说明。\n- 不评价、不排序、不总结。只输出清单。`,
    ask: `这是一场「三把尺读书」：用三把尺重新梳理这本书，观点清单见主持人那条（C 编号）。${RULERS}

请你：
1. 贝叶斯尺：挑最要紧的 3–5 条（按 C 编号），每条写：主要证据、似然比（强 / 中 / 接近 1）、读者该从几成更新到几成。开着上网时，可以查这条主张后来有没有被重复验证或反驳。
2. 奥卡姆尺：这本书的秩是几（几个独立的核心观点，各写一句、各覆盖哪些 C）；哪些 C 是冗余；哪条有更简单的解释（写出来）。
3. 万有理论尺：它是哪个更一般原理的特例；统一了什么；统一后的新预测；边界和冲突。
4. 一句话：这本书最短的描述，一句话，能推出它大部分观点。
5. 读后该做什么不同：一件具体的事，或一个可以验证的预测。
不要复述全书。这次可以写到 700 字。`,
    respond: focused => `${focused ? '主持人刚指出各位在哪把尺上分歧，并给这一轮提了一个问题（见记录最后一条）。请正面回答它' : '请对比其他人的梳理'}，点名回应和你判断不同的人：证据之争说清「如果这条主张是错的，书里的证据会不会照样出现」；压缩之争说清去掉哪条、哪些观点就推不出来；统一之争说清两个上位原理各自预测了什么不同的东西。你的判断有没有因此改变（某条该更新几成、书的秩、上位原理），变了就直说。不要重复你自己说过的话。`,
    focus: (c, whoFn) => `# 讨论记录\n\n${transcript(c, Infinity, whoFn)}\n\n# 你的任务\n这是一场「三把尺读书」，大家刚说完一轮。${RULERS}\n\n对比各位的梳理，找出最要紧的一处分歧，判断它在哪把尺上：贝叶斯（同一条 C，有人说证据强，有人说似然比接近 1）、奥卡姆（书的秩、哪条冗余、有没有更简单的解释）、还是万有理论（归到不同的上位原理）。然后给下一轮提一个问题，逼大家正面回答。\n${FOCUS_FORMAT.replace('属于哪一种', '在哪把尺上')}\n如果各位的梳理已经基本一致、再讨论只会重复，只写一行「【无分歧】」加一句原因。`,
    summary: (c, whoFn) => `# 讨论记录\n\n${transcript(c, Infinity, whoFn)}\n\n# 请整理\n这是一场「三把尺读书」。综合大家的讨论（以讨论后的版本为准），用这几个小标题：\n## 一句话\n这本书最短的描述：一句话，能推出它大部分观点。\n## 这本书的秩\n真正独立的核心观点：几个，每个一句，编号 ①②③，各覆盖哪些 C。\n## 贝叶斯：每条该信几成\n用表格，只列最要紧的 3–6 条：观点（C 编号 + 一句话）｜主要证据｜似然比（强 / 中 / 接近 1）｜该从几成到几成｜有没有分歧。查证过的标出处，没查证的标「未查证」。\n## 奥卡姆：可以删掉的\n冗余的观点；有更简单解释的观点（写出那个更简单的解释）。\n## 万有理论：它是哪个更大原理的特例\n上位原理；它统一了什么；统一后的新预测；边界和冲突。\n## 读完该做什么不同\n1–3 件具体的事，或可以验证的预测（带检验时间）。\n## 仍有分歧（谁持什么立场；标出在哪把尺上）\n## 还需要提问人回答的问题（包括请他给几成把握的）\n${NEXT_SECTIONS}\n总共不超过 1200 字。`,
  },
};

export function createRoundtableServer(options = {}) {
  const dataDir = options.dataDir ?? (process.env.ROUNDTABLE_HOME || join(homedir(), '.live-roundtable'));
  const convDir = join(dataDir, 'conversations');
  const promptsDir = options.promptsDir ?? join(REPO_ROOT, 'prompts');
  mkdirSync(convDir, { recursive: true });

  const gptrDir = options.gptrDir ?? (process.env.GPTR_DIR || '');
  const hasGptr = Boolean(
    gptrDir
    && existsSync(join(gptrDir, 'research.py'))
    && existsSync(join(gptrDir, '.venv', 'bin', 'python')),
  );

  const { seats: loadedSeats, configPath: seatsConfigPath } = loadSeats({
    seatsFile: options.seatsFile ?? (process.env.ROUNDTABLE_SEATS || undefined),
    dataDir,
    repoRoot: REPO_ROOT,
  });

  applyFallbacks(loadedSeats, readFallbacks(dataDir));

  const findBinFn = options.findBinFn ?? findBin;
  const say = options.sayFn ?? createSay({ seats: loadedSeats, findBinFn });

  // 连接自检：上次的结果存在 <dataDir>/probe.json，重启后还在；没有这个文件说明还没检查过（首次使用）
  const probePath = join(dataDir, 'probe.json');
  let probeResults = {};
  try { probeResults = JSON.parse(readFileSync(probePath, 'utf8')).results ?? {}; } catch {}
  let probing = null;
  const probeOpts = { findBinFn, runFn: options.runSeatFn ?? runSeat, timeoutMs: options.probeTimeoutMs };
  async function runProbe(ids) {
    if (probing) return probing;
    probing = (async () => {
      const list = ids?.length ? ids.filter(id => loadedSeats[id]) : Object.keys(loadedSeats);
      const done = await Promise.all(list.map(async id => [id, await probeAndApply(id, loadedSeats, dataDir, probeOpts)]));
      Object.assign(probeResults, Object.fromEntries(done));
      for (const id of Object.keys(probeResults)) if (!loadedSeats[id]) delete probeResults[id];
      writeFileSync(probePath, `${JSON.stringify({ at: new Date().toISOString(), results: probeResults }, null, 2)}\n`);
      return probeResults;
    })();
    try { return await probing; } finally { probing = null; }
  }

  const inspect = () => {
    const out = inspectSeats(loadedSeats, findBinFn);
    for (const [id, s] of Object.entries(out)) {
      s.probe = probeResults[id] ?? null;
      // 自检时 CLI 已经装上了，但上次结果还是“没装”，就别再拿旧结果吓人
      if (s.available && s.probe?.kind === 'missing') s.probe = null;
      s.setup = CLI_SETUP[s.cli] ?? null;
    }
    return out;
  };

  const defaultEfforts = Object.fromEntries(
    Object.entries(loadedSeats)
      .filter(([, s]) => s.defaultEffort && s.defaultEffort !== 'high')
      .map(([id, s]) => [id, s.defaultEffort]),
  );

  function defaultsFor(inspected) {
    return {
      // 自检没通过的席位（没登录、模型用不了等）默认不参加，免得一开讨论就报错
      seats: Object.keys(inspected).filter(id => inspected[id].available && inspected[id].probe?.ok !== false),
      web: true,
      fast: true,
      effort: 'high',
      efforts: { ...defaultEfforts },
      rounds: 2,
      autoSummary: true,
      moderator: '',
      moderatorEffort: '',
      background: '',
      personas: {},
    };
  }

  function moderatorOf(c, inspected) {
    const pick = c.settings?.moderator;
    if (pick && inspected[pick]?.available) return pick;
    const selected = c.settings?.seats ?? [];
    if (selected.includes('opus') && inspected.opus?.available) return 'opus';
    const firstSelected = selected.find(s => inspected[s]?.available);
    if (firstSelected) return firstSelected;
    return Object.keys(inspected).find(s => inspected[s].available) ?? null;
  }

  const who = m => (
    m.role === 'user' ? '提问人'
      : m.role === 'research' ? '调研员（GPT Researcher）'
      : m.role === 'helper' ? '调研助手'
      : m.role === 'summary' ? '主持人总结'
      : m.role === 'moderator' ? '主持人'
      : loadedSeats[m.seat]?.label ?? m.seat
  );

  const active = new Map();
  const running = new Map();
  const seatRuns = new Map();
  const subs = new Map();
  const live = new Map();

  const file = id => join(convDir, `${id.replace(/[^\w-]/g, '')}.json`);
  const load = id => active.get(id) ?? (existsSync(file(id)) ? JSON.parse(readFileSync(file(id), 'utf8')) : null);
  const save = c => {
    c.updated = new Date().toISOString();
    writeFileSync(file(c.id), JSON.stringify(c, null, 2));
    return c;
  };

  function track(id, e) {
    const ms = live.get(id);
    if (!ms) return;
    if (e.type === 'start') ms.set(e.msg.id, { ...e.msg, text: e.msg.text ?? '' });
    const m = ms.get(e.id);
    if (e.type === 'delta' && m) { m.text += e.text; m.status = '正在写'; }
    if (e.type === 'status' && m) m.status = e.text;
    if (e.type === 'done') ms.delete(e.msg.id);
  }
  const broadcast = (id, e) => {
    for (const r of subs.get(id) ?? []) r.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  function system(c, seatId) {
    const me = loadedSeats[seatId].label;
    const others = (c.settings.seats ?? [])
      .filter(s => s !== seatId && loadedSeats[s])
      .map(s => loadedSeats[s].label)
      .join('、');
    const persona = c.settings.personas?.[seatId]?.trim();
    const theme = c.messages.find(m => m.role === 'user')?.text;
    return [
      `你在参加一场真实的多人圆桌讨论，你是「${me}」。在场的还有${others ? `：${others}，以及` : ''}提问人。今天是 ${new Date().toISOString().slice(0, 10)}。默认用中文回答（除非提问人用其他语言提问或另有要求）。`,
      persona && `这场讨论里你的角色：${persona}`,
      theme && `这场讨论的主题（提问人最初的问题，原话）：\n「${theme.length > 1200 ? theme.slice(0, 1200) + '…' : theme}」\n每次发言都要紧扣并服务于回答这个主题，不要发散到无关的枝节。`,
      '怎么发言：',
      '- 直接给出你的判断和理由，像在会议室里说话，不客套、不复述题目。',
      '- 别人说过的你同意就一句带过，只补充新东西；不同意就点名说清哪里不同意、为什么。',
      '- 拿不准的事实标「未查证」' + (c.settings.web ? '，或者上网查证，引用附链接。' : '。'),
      '- 不要替全场做总结（有主持人），也不要每次都给一个面面俱到的清单。',
      '- 一般 150–400 字；提问人要求展开时再展开。',
      loadedSeats[seatId].vendor === 'anthropic' && c.settings.web && '- 搜索额度用完、还有对结论要紧但没查到的事实时，在发言最后另起一行写「【待查】」，下面每行一条「- 要查的具体事实（为什么要紧）」，最多 5 条，只列回答主题必需的事实。没有就不写。',
      c.settings.background?.trim() && `\n提问人给的背景：\n${c.settings.background.trim()}`,
    ].filter(Boolean).join('\n');
  }

  function historyBudget(c, seatId) {
    return loadedSeats[seatId]?.vendor === 'google'
      ? GEMINI_MAX - bytes(system(c, seatId)) - 4_000
      : Infinity;
  }

  function turnPrompt(c, mode, seatId) {
    const log = transcript(c, historyBudget(c, seatId), who);
    const last = c.messages.at(-1);
    const focused = last?.role === 'moderator' && last.text && !last.error;
    const tail = mode === 'update'
      ? '调研助手刚补查了你列的【待查】事实（见记录最后一条）。请据此更新：哪些说法确认了、哪些要改、你的判断有没有因此变化。只说变化的部分，不要重复整段发言。'
      : mode === 'special-ask' ? SPECIAL[kindOf(c)].ask
      : mode === 'special-respond' ? SPECIAL[kindOf(c)].respond(focused)
      : mode === 'respond' && focused
      ? '主持人刚指出了核心分歧，并给这一轮提了一个问题（见记录最后一条）。请正面回答这个问题，点名回应和你看法不同的人；你的看法有没有因此改变，变了就直说。不要重复你自己说过的话。'
      : mode === 'respond'
      ? '现在请你回应其他参与者刚才的发言：你同意谁、反对谁、谁漏了什么，你的看法有没有因此改变。不要重复你自己说过的话。'
      : '现在轮到你回答提问人最新的话。如果这是要做判断或决定的问题，第一句先写「我的判断标准：……」（你拿什么判断好坏、什么算成功），再给判断。';
    return `# 到目前为止的讨论\n\n${log}\n\n# 你的回合（你是 ${loadedSeats[seatId].label}）\n${tail}`;
  }

  async function runTurn(c, { mode, seats, emit, signal, round }) {
    const inspected = inspect();
    const modSeat = moderatorOf(c, inspected);
    const one = async (seatId, sys, prompt, role = 'seat') => {
      if (!seatId) {
        const m = {
          id: randomUUID(),
          role,
          seat: '',
          text: '',
          at: new Date().toISOString(),
          pending: false,
          mode,
          error: '没有可用的模型席位，请先安装并登录至少一个 CLI（claude / codex / agy）',
          ...((mode === 'inventory' || mode.startsWith('special-')) && { kind: kindOf(c) }),
        };
        emit({ type: 'start', msg: m });
        emit({ type: 'done', msg: m });
        return m;
      }
      const m = { id: randomUUID(), role, seat: seatId, text: '', at: new Date().toISOString(), pending: true };
      emit({ type: 'start', msg: m });
      // 主持人（定焦、清单、总结）可以单独指定思考强度；留空则跟随这位席位自己的设置
      const effort = (role !== 'seat' && c.settings.moderatorEffort)
        || c.settings.efforts?.[seatId] || c.settings.effort || 'high';
      const ac = new AbortController();
      const stopAll = () => ac.abort();
      signal.addEventListener('abort', stopAll, { once: true });
      if (role === 'seat') {
        if (!seatRuns.has(c.id)) seatRuns.set(c.id, new Map());
        seatRuns.get(c.id).set(seatId, ac);
      }
      const r = await say(seatId, {
        system: sys,
        prompt,
        web: role === 'seat' && c.settings.web,
        effort,
        fast: c.settings.fast,
        signal: ac.signal,
        onDelta: t => emit({ type: 'delta', id: m.id, text: t }),
        onStatus: s => emit({ type: 'status', id: m.id, text: s }),
      });
      signal.removeEventListener('abort', stopAll);
      if (role === 'seat') seatRuns.get(c.id)?.delete(seatId);
      const dropped = ac.signal.aborted && !signal.aborted;
      Object.assign(m, {
        text: dropped ? '' : r.text,
        effort,
        ...(round && { round }),
        ms: r.ms,
        usage: r.usage,
        usd: r.usd,
        speed: r.speed,
        sources: r.sources,
        searches: r.searches,
        error: dropped ? '中途取消了这位' : r.error,
        pending: false,
        mode,
        ...((mode === 'inventory' || mode.startsWith('special-')) && { kind: kindOf(c) }),
      });
      emit({ type: 'done', msg: m });
      return m;
    };

    const sp = SPECIAL[kindOf(c)];
    const done = mode === 'summary' || mode === 'special-summary'
      ? [await one(modSeat, SUMMARY_SYS, mode === 'special-summary' ? sp.summary(c, who) : summaryPrompt(c, who), 'summary')]
      : mode === 'focus' || mode === 'special-focus'
      ? [await one(modSeat, FOCUS_SYS, mode === 'special-focus' ? sp.focus(c, who) : focusPrompt(c, who), 'moderator')]
      : mode === 'inventory'
      ? [await one(modSeat, sp.inventorySys, sp.inventory(c, who), 'moderator')]
      : await Promise.all(seats.map(s => one(s, system(c, s), turnPrompt(c, mode, s))));
    c.messages.push(...done);
    save(c);
    return done;
  }

  async function discuss(c, { seats, emit, signal, round }) {
    const special = !!kindOf(c);
    const [f] = await runTurn(c, { mode: special ? 'special-focus' : 'focus', seats: seats(), emit, signal, round });
    if (signal.aborted || f.error || /【无分歧】/.test(f.text)) return false;
    await runTurn(c, { mode: special ? 'special-respond' : 'respond', seats: seats(), emit, signal, round });
    return true;
  }

  function writeCtx(c, out) {
    mkdirSync(out, { recursive: true });
    const p = join(out, 'context.md');
    writeFileSync(p, c.settings.background);
    return p;
  }

  function research(c, query, { emit, signal }) {
    return new Promise(ok => {
      const m = { id: randomUUID(), role: 'research', text: '', at: new Date().toISOString(), pending: true };
      emit({ type: 'start', msg: m });
      const out = join(convDir, `${c.id}.gptr`, String(Date.now()));
      const ctx = c.settings.background?.trim() ? ['--context', writeCtx(c, out)] : [];
      const p = spawn(
        join(gptrDir, '.venv/bin/python'),
        ['-I', join(gptrDir, 'research.py'), `${query}\n\n请用中文写，列出关键事实、各方观点和不确定之处，每条事实附出处链接，不要替决策者下结论。`, '--out', out, ...ctx],
        { cwd: gptrDir },
      );
      const t0 = Date.now();
      let err = '';
      const progress = () => {
        let buf = '';
        return d => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, '').trim();
            buf = buf.slice(i + 1);
            const s = line.match(/(Running research for .+|Scraped \d+ pages.*|Added source url to research: .+|Writing.+|conducting.+|Planning the research.+)/i)?.[1];
            if (s) emit({ type: 'status', id: m.id, text: s.slice(0, 160) });
          }
        };
      };
      p.stdout.on('data', progress());
      const errProgress = progress();
      p.stderr.on('data', d => { err = (err + d).slice(-2000); errProgress(d); });
      const kill = () => p.kill('SIGTERM');
      signal.addEventListener('abort', kill, { once: true });
      p.on('close', code => {
        signal.removeEventListener('abort', kill);
        const rp = join(out, 'report.md');
        const mp = join(out, 'meta.json');
        if (code === 0 && existsSync(rp)) {
          const meta = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : {};
          Object.assign(m, { text: readFileSync(rp, 'utf8'), usd: meta.usd, sources: (meta.sources ?? []).map(url => ({ url })), ms: Date.now() - t0 });
        } else {
          m.error = signal.aborted ? '已停止' : `GPT Researcher 失败（${code}）：${err.slice(-300)}`;
        }
        m.pending = false;
        m.ms ??= Date.now() - t0;
        emit({ type: 'done', msg: m });
        c.messages.push(m);
        save(c);
        ok();
      });
    });
  }

  async function turn(c, { mode, text, role, sources, seats }) {
    if (running.has(c.id)) return { error: '上一轮还没结束，先等它或者点停止' };
    if (mode === 'research' && !hasGptr) {
      return { error: '未配置 GPT Researcher（可通过 GPTR_DIR 环境变量启用，或直接开启顶栏「上网」让各席位搜索）' };
    }

    const inspectedAtStart = inspect();
    let named = seats;
    if (text) {
      const at = [...text.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(x => x[1].toLowerCase()).filter(s => loadedSeats[s]);
      if (at.length && (mode === 'ask' || SPECIAL[mode]) && role === 'user') named = [...new Set(at)];
    }

    const pick = () => {
      const curInspected = inspect();
      if (named) return named.filter(s => Boolean(loadedSeats[s]));
      return (c.settings.seats ?? []).filter(s => Boolean(curInspected[s]?.available));
    };

    if ((mode === 'summary') && !moderatorOf(c, inspectedAtStart)) {
      return { error: '没有可用的主持人席位，请先安装并登录至少一个 CLI（claude / codex / agy）' };
    }
    if (mode !== 'research' && mode !== 'summary' && pick().length === 0) {
      return { error: '没有可用的模型席位，请先安装并登录至少一个 CLI（claude / codex / agy），或勾选可用席位' };
    }

    live.set(c.id, new Map());
    active.set(c.id, c);
    const emit = e => { track(c.id, e); broadcast(c.id, e); };

    if (text) {
      const m = { id: randomUUID(), role, text, at: new Date().toISOString(), ...(sources && { sources }), ...(SPECIAL[mode] && { kind: mode }) };
      c.messages.push(m);
      if (c.title === '新讨论' && role === 'user') c.title = text.replace(/@[a-zA-Z0-9_-]+/g, '').trim().slice(0, 40) || '新讨论';
      save(c);
      emit({ type: 'conv', conv: { id: c.id, title: c.title } });
      emit({ type: 'done', msg: m });
    }

    const ac = new AbortController();
    running.set(c.id, ac);
    emit({ type: 'busy', on: true });
    try {
      const defs = defaultsFor(inspectedAtStart);
      if (mode === 'research') {
        await research(c, text, { emit, signal: ac.signal });
      } else if (mode === 'respond') {
        await discuss(c, { seats: pick, emit, signal: ac.signal });
      } else if (mode === 'summary') {
        await runTurn(c, { mode: kindOf(c) ? 'special-summary' : 'summary', seats: pick(), emit, signal: ac.signal });
      } else if (SPECIAL[mode]) {
        await runTurn(c, { mode: 'inventory', seats: pick(), emit, signal: ac.signal });
        if (!ac.signal.aborted) await runTurn(c, { mode: 'special-ask', seats: pick(), emit, signal: ac.signal });
        if (pick().length > 1) {
          const totalRounds = c.settings.rounds ?? defs.rounds;
          for (let round = 1; round <= totalRounds && !ac.signal.aborted && pick().length > 1; round++) {
            if (!(await discuss(c, { seats: pick, emit, signal: ac.signal, round }))) break;
          }
          if ((c.settings.autoSummary ?? defs.autoSummary) && !ac.signal.aborted) {
            await runTurn(c, { mode: 'special-summary', seats: pick(), emit, signal: ac.signal });
          }
        }
      } else {
        await runTurn(c, { mode, seats: pick(), emit, signal: ac.signal });
        if (mode === 'ask' && role === 'user' && pick().length > 1) {
          const totalRounds = c.settings.rounds ?? defs.rounds;
          for (let round = 1; round <= totalRounds && !ac.signal.aborted && pick().length > 1; round++) {
            if (!(await discuss(c, { seats: pick, emit, signal: ac.signal, round }))) break;
          }
          if ((c.settings.autoSummary ?? defs.autoSummary) && !ac.signal.aborted) {
            await runTurn(c, { mode: 'summary', seats: pick(), emit, signal: ac.signal });
          }
        }
      }
    } catch (e) {
      emit({ type: 'error', text: e.message });
    }
    running.delete(c.id);
    live.delete(c.id);
    active.delete(c.id);
    seatRuns.delete(c.id);
    emit({ type: 'busy', on: false });
    return { ok: true };
  }

  const readBody = req => new Promise((ok, no) => {
    let b = '';
    req.on('data', d => (b += d));
    req.on('end', () => {
      try { ok(b ? JSON.parse(b) : {}); }
      catch (e) { no(e); }
    });
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, v, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : (typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)));
    };
    try {
      if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        return send(200, readFileSync(join(HERE, 'index.html')), 'text/html; charset=utf-8');
      }
      if (url.pathname === '/vendor/marked.min.js' && (req.method === 'GET' || req.method === 'HEAD')) {
        return send(200, readFileSync(join(REPO_ROOT, 'vendor', 'marked.min.js')), 'application/javascript; charset=utf-8');
      }
      if (FONTS.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400' });
        return res.end(req.method === 'HEAD' ? undefined : readFileSync(join(REPO_ROOT, url.pathname)));
      }
      if (url.pathname === '/api/meta' && req.method === 'GET') {
        const inspected = inspect();
        return send(200, {
          seats: inspected,
          defaults: defaultsFor(inspected),
          features: { research: hasGptr },
          probe: { checked: existsSync(probePath), running: Boolean(probing) },
          special: Object.fromEntries(
            Object.entries(SPECIAL).map(([k, x]) => [
              k,
              { label: x.label, template: readFileSync(join(promptsDir, `${x.label}-模板.md`), 'utf8') },
            ]),
          ),
        });
      }
      if (url.pathname === '/api/probe' && req.method === 'POST') {
        const b = await readBody(req);
        await runProbe(Array.isArray(b.seats) ? b.seats : null);
        const inspected = inspect();
        return send(200, { seats: inspected, defaults: defaultsFor(inspected) });
      }
      if (url.pathname === '/api/convs' && req.method === 'GET') {
        const list = readdirSync(convDir)
          .filter(f => f.endsWith('.json'))
          .map(f => JSON.parse(readFileSync(join(convDir, f), 'utf8')))
          .map(c => ({ id: c.id, title: c.title, updated: c.updated, n: c.messages.length }))
          .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
        return send(200, list);
      }
      if (url.pathname === '/api/convs' && req.method === 'POST') {
        const b = await readBody(req);
        const defs = defaultsFor(inspect());
        const c = {
          id: `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`,
          title: '新讨论',
          created: new Date().toISOString(),
          settings: { ...defs, ...b.settings },
          messages: [],
        };
        return send(200, save(c));
      }
      const m = url.pathname.match(/^\/api\/convs\/([\w-]+)(?:\/(\w+))?$/);
      if (!m) return send(404, { error: 'not found' });
      const c = load(m[1]);
      if (!c) return send(404, { error: '没有这场讨论' });
      const action = m[2];
      if (!action && req.method === 'GET') return send(200, c);
      if (action === 'settings' && req.method === 'POST') {
        Object.assign(c.settings, await readBody(req));
        for (const [s, ctl] of seatRuns.get(c.id) ?? []) {
          if (!c.settings.seats.includes(s)) ctl.abort();
        }
        return send(200, save(c));
      }
      if (action === 'stop' && req.method === 'POST') {
        running.get(c.id)?.abort();
        return send(200, { ok: true });
      }
      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'busy', on: running.has(c.id) })}\n\n`);
        for (const msg of live.get(c.id)?.values() ?? []) {
          res.write(`data: ${JSON.stringify({ type: 'start', msg })}\n\n`);
          if (msg.status) res.write(`data: ${JSON.stringify({ type: 'status', id: msg.id, text: msg.status })}\n\n`);
        }
        if (!subs.has(c.id)) subs.set(c.id, new Set());
        subs.get(c.id).add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); subs.get(c.id)?.delete(res); });
        return;
      }
      if (action === 'say' && req.method === 'POST') {
        const b = await readBody(req);
        const mode = b.mode ?? 'ask';
        const text = (b.text ?? '').trim();
        if ((mode === 'ask' || mode === 'research' || SPECIAL[mode]) && !text) return send(400, { error: '先写点什么' });
        const r = await turn(c, { mode, text, role: 'user' });
        return send(r.error ? 409 : 200, r);
      }
      if (action === 'prepare' && req.method === 'POST') {
        const b = await readBody(req);
        const text = (b.text ?? '').trim();
        if (!text) return send(400, { error: '先写下你想讨论的问题' });
        if (running.has(c.id)) return send(409, { error: '这场讨论正在进行一轮，等它结束再配局' });
        const inspected = inspect();
        const modSeat = moderatorOf(c, inspected);
        if (!modSeat) {
          return send(409, { error: '没有可用的主持人席位，请先安装并登录至少一个 CLI（claude / codex / agy）' });
        }
        const at = [...text.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(x => x[1].toLowerCase()).filter(s => inspected[s]?.available);
        const selected = (Array.isArray(b.seats) ? b.seats : (c.settings.seats ?? [])).filter(s => inspected[s]?.available);
        const targetSeats = at.length ? [...new Set(at)] : (selected.length ? selected : [modSeat]);

        const ac = new AbortController();
        const onClose = () => { if (!res.writableEnded) ac.abort(); };
        res.on('close', onClose);
        const r = await say(modSeat, {
          system: PREPARE_SYS,
          prompt: preparePrompt(c, text, targetSeats, loadedSeats),
          web: false,
          effort: 'medium',
          fast: c.settings.fast,
          signal: ac.signal,
        });
        res.off('close', onClose);
        if (ac.signal.aborted) return;
        if (r.error) return send(502, { error: r.error });

        const parsed = parsePrepareOutput(r.text, targetSeats);
        if (parsed.error) return send(502, { error: parsed.error });

        if (b.apply !== false) {
          if (parsed.background) c.settings.background = parsed.background;
          if (Object.keys(parsed.personas).length) {
            c.settings.personas = { ...(c.settings.personas ?? {}), ...parsed.personas };
          }
          save(c);
        }
        return send(200, {
          ok: true,
          seat: modSeat,
          ms: r.ms ?? 0,
          background: parsed.background,
          personas: parsed.personas,
          missing: parsed.missing,
          settings: c.settings,
        });
      }
      if (action === 'note' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.text?.trim()) return send(400, { error: 'text 不能为空' });
        if (running.has(c.id)) return send(409, { error: '这场讨论正在进行一轮，等它结束再补充' });
        const mod = moderatorOf(c, inspect());
        const replySeats = b.reply ?? (mod ? [mod] : []);
        if (!replySeats.length) return send(400, { error: '没有可用的回复席位' });
        turn(c, { mode: 'update', text: b.text.trim(), role: 'helper', sources: b.sources, seats: replySeats });
        return send(200, { ok: true });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e.message });
    }
  });

  return { server, dataDir, convDir, seats: loadedSeats, seatsConfigPath, hasGptr, inspect, runProbe };
}
