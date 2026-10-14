# mcd-cooldown

**额度还没回来。饭先核好价。下单键在你手里。**

Claude Code、Codex 或 Cursor 的额度见底，或者写到了午饭晚饭，状态栏会提你起来吃，并带上已经核好的价。本地 MCP 网关把 Token 留在本机，下单、抽奖和积分兑换默认只核价，你在终端确认后才放行。不弹窗，也没有常驻进程。换客户端也一样。

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

1. 安装。`npm install` 会编译出 `dist/src/cli.js`，`npm link` 让 `mcd-cooldown` 可以直接敲。

```bash
git clone https://github.com/Adonis0123/mcd-cooldown.git && cd mcd-cooldown && npm install && npm link
```

`npm link` 要是提示权限不足，把最后一段换成 `sudo npm link`。如果终端仍找不到命令，执行 `export PATH="$(npm prefix -g)/bin:$PATH"`。没链上时，程序提示里会改用 `node` 加这份安装的绝对路径，复制就能跑。

2. Token 只留在本机终端。不要写进仓库，也不要贴进对话。

```bash
export MCD_MCP_TOKEN="从 open.mcd.cn 复制的 Token"
```

3. 选门店和常点的餐，并接到 Claude Code。

```bash
mcd-cooldown init && mcd-cooldown setup claude
```

`init` 在交互终端里问城市和关键词，用只读的 `query-nearby-stores` 列出门店，你输入序号选定；再用只读的 `query-meals` 列出这家店的菜单，你选常点的几项。查菜单时会带上下一个午饭或晚饭（默认 12:00 和 18:30，当天这两顿都过了就用明天的午饭），所以早上初始化选到的是正餐，不是当时正在卖的早餐。配置写入 `~/.mcd-cooldown/config.json`。接着问要不要在状态栏提醒午饭和晚饭，默认工作日 12:00 和 18:30。这一步不下单。

没有交互终端时，把选择写在参数里。`--store` 和 `--item` 先按编码匹配，对不上再按序号。`--item` 可以重复。门店和餐品都能对上时，只打印选定结果。对不上，或只给了城市和关键词时，仍会打出编号列表，不写配置。

```bash
mcd-cooldown init --city 上海 --keyword 南京西路 --store 门店编码 --item 餐品编码
```

没有 Token、只想看流程时，加上 `--mock`。那是样例门店，不会连接官方服务，也不会下单。

`setup claude` 把状态栏和 Stop hook 合并进 `~/.claude/settings.json`，命令里是这份安装的绝对路径。写入前先备份。已经合并过再跑一次不会重复添加。想先看 JSON：`mcd-cooldown setup claude --print`（`--dry-run` 相同，不写文件）。

离线预览不连接麦当劳：`mcd-cooldown demo`，以及 `mcd-cooldown doctor --mock`。样例门店和价格不是官方实时数据。有 Token 之后，`mcd-cooldown doctor` 只做只读自检：检查 Token 有没有漏进项目文件，然后列出工具，并查询当前时间、活动日历和营养数据长度。它不查订单、不领券、不抽奖、不下单。加 `--city 上海 --keyword 南京西路` 可以再列一次附近门店；查到 0 家会告警并建议换关键词。到店自取（`beType` 为 1）没有 `beCode`。`beCode` 只有得来速（`beType` 为 5）、外送（`beType` 为 2）和企业团餐（`beType` 为 6）才需要，这三种之外不要传。门店不在营业时间时，上游错误码 `600057` 会说成「门店当前不营业，可换 24 小时门店或改用预约（reservationDate）」。早上核价遇到错误码 `60006`、并且还没到下一顿午饭或晚饭（默认 12:00 / 18:30，已写入配置的钟点优先）时，会说明现在还是早餐时段、保存的正餐还没开卖、饭点提醒会在饭点前核价，不必重新跑 `init`。已经在饭点附近、餐品仍然不可售时，才说「常点里有这个时段不卖的餐品（比如早餐款），重新跑 init 换一份」。`doctor` 和 `plan` 在连接官方服务时，如果门店编码仍是 `init --mock` 留下的 `SAMPLE-` 样例门店，会直接说明要换真实 Token 再跑 `init`，不会把 Token 打出来。

## 它做什么

```mermaid
flowchart LR
  client["Claude Code / Codex / Cursor"]
  guard["mcd-cooldown 本机网关"]
  mcd["https://mcp.mcd.cn"]
  client -->|"stdio 或 127.0.0.1，配置里没有 Token"| guard
  guard -->|"Authorization 只在这一跳"| mcd
```

一层是 **mcd-guard**。它站在任意 MCP 客户端和麦当劳 MCP 之间。Token 放在环境变量或 `~/.mcd-cooldown/token`，不进模型上下文。`create-order`、`cancel-order`、`auto-bind-coupons`、`draw-lottery`、`mall-create-order`、`delivery-create-address`、`party-order-create` 会在协议层被拦住。模型就算重试，也只是再拿到一次「未提交」。

另一层是 **cooldown**。Claude Code 把额度窗口从状态栏标准输入送进来。接近用尽时，按 `resets_at` 倒推一个确认时间，并用你保存的常点餐品调用 `calculate-price`。到店自取是默认场景，起来走一趟也当作休息。确认之前没有任何订单。

午饭和晚饭也走这一条状态栏。你配置的是想几点吃上，默认工作日 12:00 和 18:30。提醒时刻用出餐或配送时间往前倒：`calculate-price` 里若有预计分钟就用它，没有就用默认 20 分钟。状态栏写成「现在确认，约 12:05 可取」。外送则是「现在确认，约 12:05 送达」。每顿每天的 Stop hook 最多说一次。已吃或带了饭、稍后 15 分钟、今天跳过，各是一条命令。已经确认过的那顿，或者过了饭点 45 分钟，提醒自己消失。额度快用完又刚好是饭点时，合成一条，不说两遍。

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

不用手贴 JSON。在仓库目录执行：

```bash
mcd-cooldown setup claude
```

它会把下面这种状态栏和 Stop hook 合并进 `~/.claude/settings.json`，并把 `/ABSOLUTE/PATH` 换成这台机器上的绝对路径。原文件会先复制备份。再执行一次不会多加一条 hook。`setup claude --print` 只打印结果，不写文件。状态栏会频繁执行，所以命令指向本机文件，不走 `npx`。

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

`${MCD_MCP_TOKEN}` 由你的 shell 提供。不要把真实 Token 写进这个 JSON。

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

测试使用合成样例，不连接官方服务，也不包含真实 Token、订单或地址。`init --mock` 和 `setup claude --print` 也在测试里。配置 Token 之后，用 `doctor` 做一次真实只读验证。

## 参赛文件

仓库根目录包含 `README.md`、原样复制的 `CONTEST_DECLARATION.md`、`MCP_INTEGRATION.md` 和 `mcp-config.example.json`。可直接粘贴的报名正文在 `docs/contest-issue.md`。建议 Issue 标题：`【参赛申请】mcd-cooldown：额度用完，先核价`。

## 许可

MIT。麦当劳名称用于说明所接入的官方 MCP 服务。本项目与麦当劳没有隶属关系，也不构成官方背书。
