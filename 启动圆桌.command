#!/usr/bin/env bash
set -u

cd "$(dirname "$0")" || exit 1

# 补全 macOS Finder 双击启动时可能缺失的 PATH（Homebrew / nvm / ~/.local/bin）
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  latest_nvm_bin=$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -n 1)
  if [ -n "$latest_nvm_bin" ]; then
    export PATH="$latest_nvm_bin:$PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js（需要 Node.js 20 及以上版本）。"
  echo "请先安装 Node.js：https://nodejs.org/  或运行  brew install node"
  read -r -n 1 -p "按任意键关闭..."
  echo
  exit 1
fi

node_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$node_major" -lt 20 ]; then
  echo "当前 Node.js 版本过低（$(node -v)），需要 v20 及以上版本。"
  read -r -n 1 -p "按任意键关闭..."
  echo
  exit 1
fi

exec node "./bin/cli.mjs" --open
