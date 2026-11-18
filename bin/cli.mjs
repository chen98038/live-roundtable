#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inspectSeats, loadSeats } from '../src/seats.mjs';
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
      --doctor           仅检查 Node、数据目录与各模型 CLI 可用性后退出
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

  if (values.doctor) {
    console.log(`Node 版本: ${process.version}`);
    console.log(`数据目录: ${dataDir}`);
    const { seats, configPath } = loadSeats({ seatsFile, dataDir, repoRoot: REPO_ROOT });
    console.log(`席位配置: ${configPath ?? '默认内置（未发现 seats.json）'}`);
    console.log('席位检测:');
    const inspected = inspectSeats(seats);
    for (const [id, s] of Object.entries(inspected)) {
      if (s.available) {
        console.log(`  ✓ ${id.padEnd(8)} (${s.label}) -> ${s.cli}: ${s.bin}${s.model ? ` [${s.model}]` : ' [默认模型]'}`);
      } else {
        console.log(`  ✗ ${id.padEnd(8)} (${s.label}) -> ${s.hint}`);
      }
    }
    process.exit(0);
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
