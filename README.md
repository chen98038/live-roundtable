# 实时圆桌（live-roundtable）

让多个本地大模型 CLI 并行参与同一场讨论：**独立作答 → 主持人抓出核心分歧定焦 → 多轮点名互评 → 主持人总结**，零第三方 npm 依赖，开箱即用。

还内置两个结构化深度模式：
- **找秩**：把复杂问题拆到最少几个彼此独立的基本问题，再通过反例和冗余检验收敛。
- **三把尺读书**：用贝叶斯（似然比与置信更新）、奥卡姆剃刀（最小描述长度）、万有理论三把尺重新梳理一本书。读书笔记可以直接作为附件加进来。

---

## 前置条件

1. **Node.js 20+**
2. 本机已安装并登录以下任意 1 个或多个 CLI 工具（装了几个就会启用几个席位，未安装的席位会在页面的设置里自动置灰）：
   - `claude`（Claude Code CLI，对应 Opus / Fable）
   - `codex`（OpenAI Codex CLI，对应 GPT-6.2 astra / sol；需要 codex 0.169 及以上）
   - `agy`（Antigravity CLI，对应 Gemini 4 Neon / Carbon）

注意：这里用的是**命令行工具**，不是 ChatGPT / Gemini 的网页或 App。有账号还需要装好对应的命令行并登录一次。

### 给第一次用的朋友：三步装好

1. 装 Node.js 20 及以上：<https://nodejs.org/>，或 `brew install node`
2. 装你有账号的那几家，并各登录一次（只有 ChatGPT 和 Gemini 的话，Claude 那一家跳过就行）：

   | 你有的账号 | 安装 | 登录 |
   |---|---|---|
   | ChatGPT | `npm install -g @openai/codex` | 终端运行 `codex login` |
   | Google（Gemini） | 安装 Google Antigravity，并按它的说明装好 `agy` 命令行 | 终端运行一次 `agy`，按提示登录 |
   | Claude | `npm install -g @anthropic-ai/claude-code` | 终端运行 `claude`，输入 `/login` |

3. 检查一遍：

   ```bash
   node bin/cli.mjs --check
   ```

   它会给每个席位真的发一句很短的话，逐个告诉你：能不能用、没装就给安装命令、没登录就给登录命令。账号用不了配置里的模型（比如没有 `gpt-6.2-sol` 权限）时，会自动改用账号默认模型并记住。

第一次打开网页时也会自动做同样的检查，结果显示在首页；之后可以在设置面板底部的「连接检查」里重新测试。没通过的席位默认不参加讨论。

只想看命令有没有装、不调用模型的话，用 `--doctor`。

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
- `--doctor`：仅检查各 CLI 有没有装（不调用模型）
- `--check`：给每个席位发一句话，检查登录和模型，并给出修复步骤

### 方式三：不下载代码，用 `npx` 直接跑
装好 Node.js 后，不用克隆仓库、也不用安装依赖，直接运行：

```bash
npx github:chen98038/live-roundtable --open
```

连接检查同样可以这样跑：

```bash
npx github:chen98038/live-roundtable --check
```

想把代码下载到本地（以后用 `git pull` 更新）：

```bash
git clone https://github.com/chen98038/live-roundtable.git
```

也可以在 [仓库页面](https://github.com/chen98038/live-roundtable) 点 **Code → Download ZIP**，解压后双击 `启动圆桌.command`。macOS 第一次可能提示无法验证开发者，右键 → **打开** 即可。

---

## 把文件交给圆桌

想让大家读一本书的笔记或一份文档，有三种加法：

- **复制粘贴**：在访达里选中文件按 ⌘C，回到输入框按 ⌘V
- **拖进来**：把文件拖到页面上任何地方
- **选文件**：点输入框左下角的「附件」

加进来的文件显示在输入框上方，点 ✕ 可以去掉。文件在浏览器里读成文字，跟着这条消息一起发出，服务端不读你电脑上的文件。

- 只收 `.md`、`.txt` 这类纯文本，合计不超过 80KB。内容每一轮都会发给每一位，太长费用和上下文都扛不住。PDF、EPUB、Word 请先导出成文字，或者只粘贴要紧的章节。
- 不能只贴路径：圆桌读不到你电脑上的文件，整条消息只是一个路径（比如 `/Users/…/book.md`）时会被直接拦下，并提示改用上面的方法。

---

## 自定义席位和模型名

不同账号或版本可用的模型 ID 可能不同。复制示例配置到数据目录即可按需修改（支持把 `model` 设为 `""` 使用对应 CLI 的账号默认模型，或把某个席位设为 `false` 停用）：

```bash
mkdir -p ~/.live-roundtable
cp seats.example.json ~/.live-roundtable/seats.json
```

配置文件查找优先级：`--seats-file`（或环境变量 `ROUNDTABLE_SEATS`）→ `~/.live-roundtable/seats.json` → 仓库根目录 `seats.json`。

点顶栏右侧的设置按钮，可以随时修改本场讨论谁参加、每位嘉宾的角色设定和思考强度、背景约束，以及主持人用哪个模型、思考强度多少（「跟随席位」= 沿用该席位自己的思考强度）。也可以在输入框写好问题后，先点左下角的 **「AI 填背景和角色」**，让主持人起草背景并给当前参加的席位分配互补视角，微调后再开始圆桌。

页面有三种界面，在左侧栏底部的「界面」里切换，选择会记在浏览器里：
- **对话**：一条对话往下读，按「独立作答 / 第 N 轮回应」分段，总结最醒目。
- **并排**：同一阶段各位的发言并排成卡片，方便横着比较；顶栏下一排席位，点一下就参加或退出。
- **简报**：问题下面先是主持人的结论，过程收成每人一行，点开看全文；设置常驻右侧「圆桌」栏。

---

## 数据存在哪里

代码与数据完全分离，升级或重装代码包不会覆盖历史记录：

- 默认数据目录：`~/.live-roundtable/`（可通过 `--data-dir` 或环境变量 `ROUNDTABLE_HOME` 修改）
- 对话记录：`~/.live-roundtable/conversations/<id>.json`
- 连接检查结果：`~/.live-roundtable/probe.json`
- 模型回退记录：`~/.live-roundtable/model-fallbacks.json`（某个席位的模型账号用不了、已改用默认模型时记在这里；删掉这个文件，或者改了 `seats.json` 里这个席位的模型名，就会重新用配置里的模型）

---

## HTTP API（供脚本或外部 Agent 集成）

| 方法与路径 | 说明 |
|---|---|
| `GET /api/meta` | 获取席位可用状态、默认设置与特别模式模板 |
| `POST /api/probe` | 连接检查：给各席位发一句话，返回每位的状态、失败原因和修复步骤（可传 `seats` 只测其中几位） |
| `GET /api/convs` | 列出历史讨论 |
| `POST /api/convs` | 新建讨论（可传 `settings`） |
| `GET /api/convs/:id` | 获取单场讨论完整记录 |
| `POST /api/convs/:id/settings` | 更新本场设置（运行中取消勾选席位会当场停掉该席位） |
| `POST /api/convs/:id/prepare` | 开聊前由主持人根据问题起草 `background` 和各席位 `personas` 并自动保存 |
| `POST /api/convs/:id/say` | 发起一轮（`mode`: `ask` / `respond` / `summary` / `rank` / `book`） |
| `GET /api/convs/:id/events` | 订阅实时 SSE 流（`start` / `delta` / `status` / `done` / `busy`） |
| `POST /api/convs/:id/note` | 外部调研助手补充事实并触发指定席位更新判断 |
| `POST /api/convs/:id/stop` | 停止当前正在执行的回合 |

---

## 许可证

代码以 [MIT 许可证](LICENSE) 发布。`vendor/` 里随项目分发的第三方文件保留各自的许可：`marked.min.js` 为 MIT，`vendor/fonts/` 里的 Montserrat 和 Noto Sans SC 为 SIL OFL 1.1（见同目录下的授权文件）。
