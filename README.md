# 实时圆桌（live-roundtable）

让多个本地大模型 CLI 并行参与同一场讨论：**独立作答 → 主持人抓出核心分歧定焦 → 多轮点名互评 → 主持人总结**，零第三方 npm 依赖，开箱即用。

还内置两个结构化深度模式：
- **找秩**：把复杂问题拆到最少几个彼此独立的基本问题，再通过反例和冗余检验收敛。
- **三把尺读书**：用贝叶斯（似然比与置信更新）、奥卡姆剃刀（最小描述长度）、万有理论三把尺重新梳理一本书。

---

## 前置条件

1. **Node.js 20+**
2. 本机已安装并登录以下任意 1 个或多个 CLI 工具（装了几个就会启用几个席位，未安装的席位会在页面顶栏自动置灰）：
   - `claude`（Claude Code CLI，对应 Opus / Fable）
   - `codex`（OpenAI Codex CLI，对应 GPT-6.2 astra / sol）
   - `agy`（Antigravity CLI，对应 Gemini 4 Argon / Carbon）

先跑一次自检确认环境：

```bash
node bin/cli.mjs --doctor
```

---

## 启动方式

### 方式一：macOS 双击启动
直接双击包里的 `启动圆桌.command`，会自动补全常见 `PATH`、拉起本地服务并在浏览器打开界面。

### 方式二：命令行启动
```bash
node bin/cli.mjs --open
```

默认监听 `http://127.0.0.1:5232`（如果 `5232` 已被占用，会自动顺延尝试 `5233`–`5242`）。

常用参数：
- `-p, --port <port>`：指定端口
- `--host <host>`：指定监听地址（默认仅监听本机 `127.0.0.1`）
- `-d, --data-dir <dir>`：自定义记录存储目录
- `--seats-file <path>`：指定席位配置文件
- `--doctor`：仅检查 CLI 可用性

### 方式三：推到 GitHub 后用 `npx` 直接跑
把本目录推送到你的 GitHub 仓库后，朋友无需克隆或安装依赖，直接运行：

```bash
npx github:<你的用户名>/live-roundtable --open
```

---

## 自定义席位和模型名

不同账号或版本可用的模型 ID 可能不同。复制示例配置到数据目录即可按需修改（支持把 `model` 设为 `""` 使用对应 CLI 的账号默认模型，或把某个席位设为 `false` 停用）：

```bash
mkdir -p ~/.live-roundtable
cp seats.example.json ~/.live-roundtable/seats.json
```

配置文件查找优先级：`--seats-file`（或环境变量 `ROUNDTABLE_SEATS`）→ `~/.live-roundtable/seats.json` → 仓库根目录 `seats.json`。

在界面顶栏点开「背景、角色和思考」，也可以随时修改本场讨论的背景约束、每位嘉宾的角色设定、思考强度以及指定主持人。

---

## 数据存在哪里

代码与数据完全分离，升级或重装代码包不会覆盖历史记录：

- 默认数据目录：`~/.live-roundtable/`（可通过 `--data-dir` 或环境变量 `ROUNDTABLE_HOME` 修改）
- 对话记录：`~/.live-roundtable/conversations/<id>.json`

---

## HTTP API（供脚本或外部 Agent 集成）

| 方法与路径 | 说明 |
|---|---|
| `GET /api/meta` | 获取席位可用状态、默认设置与特别模式模板 |
| `GET /api/convs` | 列出历史讨论 |
| `POST /api/convs` | 新建讨论（可传 `settings`） |
| `GET /api/convs/:id` | 获取单场讨论完整记录 |
| `POST /api/convs/:id/settings` | 更新本场设置（运行中取消勾选席位会当场停掉该席位） |
| `POST /api/convs/:id/say` | 发起一轮（`mode`: `ask` / `respond` / `summary` / `rank` / `book`） |
| `GET /api/convs/:id/events` | 订阅实时 SSE 流（`start` / `delta` / `status` / `done` / `busy`） |
| `POST /api/convs/:id/note` | 外部调研助手补充事实并触发指定席位更新判断 |
| `POST /api/convs/:id/stop` | 停止当前正在执行的回合 |
