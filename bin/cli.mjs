#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { applyFallbacks, CLI_SETUP, inspectSeats, loadSeats, probeAndApply, readFallbacks } from '../src/seats.mjs';
import { createRoundtableServer } from '../src/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

function printHelp() {
  console.log(`实时圆桌（live-roundtable）

用法：
  live-roundtable [选项]
  node bin/cli.mjs [选项]

选项：
  -p, --port <port>      监听端口（默认 5232；未指定时如被占用自动顺延至 5233–5242）
      --host <host>      监听地址（默认 127.0.0.1，仅本机访问）
  -d, --data-dir <dir>   讨论记录与本地配置目录（默认 ~/.live-roundtable，也可用 ROUNDTABLE_HOME）
      --seats-file <p>   自定义席位配置文件路径（也可用 ROUNDTABLE_SEATS）
      --open             启动后自动打开浏览器
      --no-open          启动后不自动打开浏览器（默认）
      --doctor           仅检查 Node、数据目录与各模型 CLI 是否装好后退出（不调用模型）
      --check            给每个席位真的发一句话，检查是否登录、模型能否使用，并给出修复步骤
  -h, --help             显示帮助信息
`);
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'darwin') {
      child = spawn('open', [url], { stdio: 'ignore', detached: true });
    } else if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true });
    } else {
      child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    }
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = err => {
      server.off('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.off('error', onErr);
      resolve(server.address().port);
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        'data-dir': { type: 'string', short: 'd' },
        'seats-file': { type: 'string' },
        open: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        doctor: { type: 'boolean' },
        check: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`参数错误：${e.message}`);
    printHelp();
    process.exit(1);
  }

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const dataDir = values['data-dir'] || process.env.ROUNDTABLE_HOME || join(homedir(), '.live-roundtable');
  const seatsFile = values['seats-file'] || process.env.ROUNDTABLE_SEATS || undefined;

  if (values.doctor || values.check) {
    console.log(`Node 版本: ${process.version}`);
    console.log(`数据目录: ${dataDir}`);
    const { seats, configPath } = loadSeats({ seatsFile, dataDir, repoRoot: REPO_ROOT });
    applyFallbacks(seats, readFallbacks(dataDir));
    console.log(`席位配置: ${configPath ?? '默认内置（未发现 seats.json）'}`);
    console.log('席位检测:');
    const inspected = inspectSeats(seats);
    const missingClis = new Set();
    for (const [id, s] of Object.entries(inspected)) {
      const model = s.model ? ` [${s.model}]` : s.fallbackFrom ? ` [账号默认模型；${s.fallbackFrom} 用不了]` : ' [默认模型]';
      if (s.available) {
        console.log(`  ✓ ${id.padEnd(8)} (${s.label}) -> ${s.cli}: ${s.bin}${model}`);
      } else {
        console.log(`  ✗ ${id.padEnd(8)} (${s.label}) -> ${s.hint}`);
        missingClis.add(s.cli);
      }
    }
    if (missingClis.size) {
      console.log('\n没装的命令行（只想用其中几家的话，没装的可以不管）：');
      for (const cli of missingClis) {
        const x = CLI_SETUP[cli];
        if (x) console.log(`  ${x.name}\n    安装：${x.installCmd ?? x.install}\n    登录：${x.login}`);
      }
    }
    if (!values.check) {
      console.log('\n只检查了命令有没有装。要确认登录和模型都没问题，运行 --check。');
      process.exit(0);
    }

    const ids = Object.keys(inspected).filter(id => inspected[id].available);
    if (!ids.length) {
      console.log('\n一个能用的命令行都没有，先按上面的步骤装好并登录。');
      process.exit(1);
    }
    console.log(`\n连接测试（给每位发一句很短的话，最长约 2 分钟）：`);
    const results = await Promise.all(ids.map(async id => {
      const r = await probeAndApply(id, seats, dataDir);
      const s = inspected[id];
      const secs = r.ms ? `${(r.ms / 1000).toFixed(1)} 秒` : '';
      if (r.ok && r.fallbackFrom) console.log(`  ✓ ${id.padEnd(8)} (${s.label}) 能用，但账号用不了 ${r.fallbackFrom}，已改用账号默认模型 ${secs}`);
      else if (r.ok) console.log(`  ✓ ${id.padEnd(8)} (${s.label}) 能用 ${secs}`);
      else console.log(`  ✗ ${id.padEnd(8)} (${s.label}) ${r.reason}：${r.fix}${r.detail ? `\n      原始报错：${r.detail.replace(/\s+/g, ' ').slice(0, 240)}` : ''}`);
      return [id, r];
    }));
    // 和网页里的“测试连接”共用结果，打开网页时不用再测
    const probePath = join(dataDir, 'probe.json');
    let prev = {};
    try { prev = JSON.parse(readFileSync(probePath, 'utf8')).results ?? {}; } catch {}
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(probePath, `${JSON.stringify({ at: new Date().toISOString(), results: { ...prev, ...Object.fromEntries(results) } }, null, 2)}\n`);
    const okCount = results.filter(([, r]) => r.ok).length;
    console.log(`\n${okCount} / ${results.length} 个席位能用。${okCount ? '可以开始了：双击「启动圆桌.command」，或运行 npm start。' : '按上面的提示修好后再运行一次 --check。'}`);
    process.exit(okCount ? 0 : 1);
  }

  const host = values.host || process.env.HOST || '127.0.0.1';
  const explicitPort = values.port ?? process.env.PORT;
  const basePort = explicitPort !== undefined ? Number(explicitPort) : 5232;
  if (!Number.isInteger(basePort) || basePort < 0 || basePort > 65535) {
    console.error(`无效端口号：${explicitPort}`);
    process.exit(1);
  }

  const { server, seatsConfigPath, inspect } = createRoundtableServer({
    dataDir,
    seatsFile,
  });

  let actualPort = null;
  const candidates = explicitPort !== undefined
    ? [basePort]
    : Array.from({ length: 11 }, (_, i) => basePort + i);

  for (const port of candidates) {
    try {
      actualPort = await listenOn(server, port, host);
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE' && explicitPort === undefined) continue;
      console.error(`启动失败（${host}:${port}）：${err.message}`);
      process.exit(1);
    }
  }

  if (actualPort === null) {
    console.error(`端口 ${basePort}–${basePort + 10} 均已被占用，请通过 --port 指定其他端口。`);
    process.exit(1);
  }

  const inspected = inspect();
  const availCount = Object.values(inspected).filter(s => s.available).length;
  const totalCount = Object.keys(inspected).length;
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${actualPort}`;

  console.log(`实时圆桌已启动：${url}`);
  console.log(`数据目录：${dataDir}`);
  if (seatsConfigPath) console.log(`席位配置：${seatsConfigPath}`);
  console.log(`可用席位：${availCount} / ${totalCount}（运行 --doctor 可查看详情）`);

  const shouldOpen = Boolean(values.open) && !values['no-open'];
  if (shouldOpen) openBrowser(url);

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
