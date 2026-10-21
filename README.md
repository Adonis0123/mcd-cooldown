# mcd-cooldown

**额度还没回来。饭先核好价。下单键在你手里。**

Claude Code、Codex 或 Cursor 的额度见底，或者写到了午饭晚饭，状态栏会提你起来吃，并带上已经核好的价。本地 MCP 网关把 Token 留在本机，下单、抽奖和积分兑换默认只核价，你在终端确认后才放行。不弹窗，也没有常驻进程。换客户端也一样。

适合在这些客户端里写代码、想自己确认后再下单的人。不替你支付，也不会自动下单。

非麦当劳官方产品。价格和供应以麦当劳官方实时结果为准。输出不是营养或医疗建议。

![额度倒计时和只核价的终端预览](docs/terminal.png)

```text
┌─ mcd-cooldown ────────────────────────────────────────────┐
│ 5h 额度 96% · 约 41 分钟后恢复                            │
│ 建议 21:41 前确认。到店自取，起身活动一下。现在只是核价。 │
│ 核价 ¥36.50 · 常点一份 · 只核价，未下单                   │
│ 确认 mcd-cooldown confirm 7f3a2c1b                        │
│ 网关已拦住写操作 · Token 不进模型                         │
└───────────────────────────────────────────────────────────┘
非麦当劳官方产品 · 默认只核价 · 确认后才下单
```

## 三步开始

1. 安装。

```bash
npm install -g github:Adonis0123/mcd-cooldown
```

2. 把 Token 留在本机文件里。不要写进仓库，也不要贴进对话。

```bash
mcd-cooldown token
```

粘贴时不回显；从标准输入读也可以，删掉用 `mcd-cooldown token --clear`。只在当前终端临时生效的话，再 `export MCD_MCP_TOKEN=...`。

3. 选门店和常点的餐，并接到 Claude Code。这一步只读，不下单。

```bash
mcd-cooldown init && mcd-cooldown setup claude
```

然后重开 Claude Code。空闲时状态栏类似 `mcd · 已就绪 · 午饭 12:00 · 常点 鸡薯双全盒`。门店参数、`--mock`、doctor、错误码，以及想改代码时的克隆方式，见 [常见问题](docs/faq.md)。

## 它做什么

```mermaid
flowchart LR
  client["Claude Code / Codex / Cursor"]
  guard["mcd-cooldown 本机网关"]
  mcd["https://mcp.mcd.cn"]
  client -->|"stdio 或 127.0.0.1，配置里没有 Token"| guard
  guard -->|"Authorization 只在这一跳"| mcd
```

一层是 **mcd-guard**。它站在任意 MCP 客户端和麦当劳 MCP 之间。Token 用 `mcd-cooldown token` 写到 `~/.mcd-cooldown/token`，不进模型上下文。环境变量 `MCD_MCP_TOKEN` 仍然优先，但只对当前终端有效。`create-order`、`cancel-order`、`auto-bind-coupons`、`draw-lottery`、`mall-create-order`、`delivery-create-address`、`party-order-create` 会在协议层被拦住。模型就算重试，也只是再拿到一次「未提交」。

另一层是 **cooldown**。Claude Code 把额度窗口从状态栏标准输入送进来。接近用尽时，按 `resets_at` 倒推一个确认时间，并用你保存的常点餐品调用 `calculate-price`。到店自取是默认场景，起来走一趟也当作休息。确认之前没有任何订单。

午饭和晚饭也走这一条状态栏。你配置的是想几点吃上，默认工作日 12:00 和 18:30。提醒时刻用出餐或配送时间往前倒：`calculate-price` 里若有预计分钟就用它，没有就用默认 20 分钟。只有已经核好价、并且有待确认请求时，状态栏才写成「现在确认，约 12:05 可取」。外送则是「现在确认，约 12:05 送达」。读不到 Token 时改为提示运行 `token`。核价没成功时提示运行 `plan` 看原因。每顿每天的 Stop hook 最多说一次。已吃或带了饭、稍后 15 分钟、今天跳过，各是一条命令。已经确认过的那顿，或者过了饭点 45 分钟，提醒自己消失。额度快用完又刚好是饭点时，合成一条，不说两遍。还没到提醒的时候，状态栏只留一行短状态，带上下一顿饭点和常点名称。还没选门店或常点时，会提示运行 `init`。这一行不联网，也不催你下单。

```text
mcd · 已就绪 · 午饭 12:00 · 常点 鸡薯双全盒
```

```text
mcd · 午饭时间 · 起来吃一点 · 现在确认，约 12:05 可取 · 已核价 ¥36.50 · 确认 7f3a2c1b
```

赶上额度窗口时：

```text
mcd · 午饭时间 · 现在确认，约 12:05 可取 · 已核价 ¥36.50 · 确认 7f3a2c1b · 5h 96% · 41 分钟后恢复
```

写到比较晚（默认北京时间 23:00 到次日 06:00）时，状态栏会先说「夜深了，先休息」。饭点提醒让路。这个时段可以核价，但不会生成待确认单，除非执行 `plan --allow-quiet`。真要提交也必须加上 `--allow-quiet`。份量按你自己保存的那一份，不额外加购。时间按配置里的时区计算，默认北京时间。`pending` 和 `log` 也按这个时区显示。

网关拦住的是 MCP 工具调用。如果你的客户端还能执行本机命令，请不要让它自动运行 `confirm`。金额上限和休息时段开关仍然有效，但挡不住一个被允许执行任意命令的代理。

## 接到 Claude Code

不用手贴 JSON。执行：

```bash
mcd-cooldown setup claude
```

它会把下面这种状态栏和 Stop hook 合并进 `~/.claude/settings.json`，并把 `/ABSOLUTE/PATH` 换成这台机器上正在运行的 `cli.js` 绝对路径。全局安装后，这条路径在 prefix 的 `lib/node_modules/mcd-cooldown/dist/src/cli.js`，不看当前目录。原文件会先复制备份。再执行一次不会多加一条 hook。`setup claude --print` 只打印结果，不写文件。状态栏会频繁执行，所以命令指向本机文件，不走 `npx`。写完之后重开 Claude Code，状态栏才会出现。

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /ABSOLUTE/PATH/mcd-cooldown/dist/src/cli.js statusline",
    "padding": 0
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /ABSOLUTE/PATH/mcd-cooldown/dist/src/cli.js hook"
          }
        ]
      }
    ]
  }
}
```

完整片段在 `examples/claude-settings.json`。Codex 或其他终端没有同一份状态栏 JSON 时，可以把同一条 `statusline` 命令放进你自己的 prompt，或者在额度用尽时调用 `hook`。这是可选项，网关本身不依赖某一个客户端。

客户端 MCP 配置只指向本地网关。可复制的占位示例是仓库根目录的 `mcp-config.example.json`：

```json
{
  "mcpServers": {
    "mcd-cooldown": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/mcd-cooldown/dist/src/cli.js", "guard"],
      "env": {
        "MCD_MCP_TOKEN": "${MCD_MCP_TOKEN}",
        "MCD_MCP_URL": "https://mcp.mcd.cn"
      }
    }
  }
}
```

`${MCD_MCP_TOKEN}` 由你的 shell 提供。从 IDE 启动时，那个 export 带不过来，网关改读 `~/.mcd-cooldown/token`。不要把真实 Token 写进这个 JSON。

`init` 写好的是到店自取：`beType` 为 1，`takeWayCode` 为 `eat-in`，没有 `beCode`。字段形状见 `examples/config.example.json`。得来速、外送和团餐要自己补上 `beCode`。改饭点：

```bash
mcd-cooldown meals lunch 12:15
mcd-cooldown meals dinner 19:00
mcd-cooldown ate
mcd-cooldown later
mcd-cooldown skip
```

`ate` 表示这顿已经吃了或带了饭，`later` 是 15 分钟后再说，`skip` 是今天这顿跳过。周末默认关闭，`meals weekends on` 才连周末一起看。系统通知默认关闭；`meals notify on` 之后，也只在那一次 Stop hook 里尝试发送。非交互环境想直接打开饭点提醒，给 `init` 加上 `--meals`，或之后执行 `meals on`。

然后：

```bash
mcd-cooldown plan
mcd-cooldown confirm <请求号>
mcd-cooldown watch <订单号>
```

`confirm` 会再核一次价。超限、读不到金额，或请求过期，都不会下单。支付链接需要你自己打开，程序不代付。

## 命令

| 命令 | 作用 |
|---|---|
| `token` | 把 Token 写到本机 `~/.mcd-cooldown/token`，权限 0600。不回显。`--clear` 删除 |
| `init` | 按城市和关键词选择门店和常点餐品，写入配置。只读，不下单 |
| `setup claude` | 把状态栏和 Stop hook 合并进 `~/.claude/settings.json`。先备份，可重复执行。`--print` 只预览 |
| `doctor` | 只读自检。没有 Token 时加 `--mock` |
| `guard` | 标准输入输出上的 MCP 网关 |
| `serve` | 只监听 `127.0.0.1:39217` 的 HTTP 网关 |
| `plan` | 按额度恢复时间核价，不下单。休息时段不生成待确认单，除非 `--allow-quiet` |
| `statusline` | 打印一行状态。不联网 |
| `hook` | 在额度偏高、饭点、连续写作或休息时段提醒，并可准备核价 |
| `meals` | 开关饭点提醒，或改午饭、晚饭、周末 |
| `ate` / `later` / `skip` | 这顿已吃、15 分钟后再说、今天跳过 |
| `confirm` / `deny` | 本机放行或拒绝一笔被拦住的操作 |
| `pending` / `log` | 查看待确认请求和脱敏后的调用记录，时间按配置时区显示 |
| `watch` | 查询订单状态并留给状态栏 |
| `mock` | 本机样例 MCP，不是官方实时数据 |
| `demo` | 离线终端预览 |

默认单笔 80 元，当日 150 元，单笔最多 12 份。可在配置或 `MCD_MAX_ORDER_CNY`、`MCD_DAILY_LIMIT_CNY`、`MCD_MAX_ITEM_QUANTITY` 里改。主题活动下单没有餐饮核价，仍然必须确认，并计入每日非餐饮写操作次数。

## 测试

```bash
npm test
```

测试使用合成样例，不连接官方服务，也不包含真实 Token、订单或地址。`init --mock` 和 `setup claude --print` 也在测试里。另外会在临时目录走一遍 `npm install -g` 的 git 安装，并核对 `dist/src` 与源码一致。配置 Token 之后，用 `doctor` 做一次真实只读验证。

## 参赛文件

仓库根目录包含 `README.md`、原样复制的 `CONTEST_DECLARATION.md`、`MCP_INTEGRATION.md` 和 `mcp-config.example.json`。可直接粘贴的报名正文在 `docs/contest-issue.md`。建议 Issue 标题：`【参赛申请】mcd-cooldown：额度用完，先核价`。

## 许可

MIT。麦当劳名称用于说明所接入的官方 MCP 服务。本项目与麦当劳没有隶属关系，也不构成官方背书。
