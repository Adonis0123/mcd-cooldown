# 常见问题

这里是首次上手不必先看的细节。三步命令在 [README](../README.md#三步开始)。

## 想改代码

上手用 `npm install -g github:Adonis0123/mcd-cooldown` 即可，不必克隆。要改源码时再克隆。仓库里的 `dist/src` 是编译结果，`npm test` 和 CI 会核对它和源码是否一致。

```bash
git clone https://github.com/Adonis0123/mcd-cooldown.git
cd mcd-cooldown
npm install
npm run compile
npm link
```

`package.json` 里不要加名叫 `build`、`prepare`、`prepack` 或 `install` 的脚本。`npm install -g github:...` 看到这些名字，会在临时目录里再跑一次安装；`tsc` 不在 PATH 上时，安装会以退出码 127 失败。编译用 `npm run compile`。

不使用 `npm link` 时，用 `node dist/src/cli.js` 跑同样的命令：

```bash
node dist/src/cli.js demo
node dist/src/cli.js doctor --mock
node dist/src/cli.js init
node dist/src/cli.js setup claude
```

`npm link` 或全局安装提示权限不足时，可以用 `sudo npm link`，或 `sudo npm install -g github:Adonis0123/mcd-cooldown`。终端仍找不到命令时，执行 `export PATH="$(npm prefix -g)/bin:$PATH"`。没链上时，程序提示里会改用 `node` 加这份安装的绝对路径，复制就能跑。

`setup claude` 写入的状态栏和 Stop hook 是这份安装的绝对路径。全局安装后指向 prefix 里的 `lib/node_modules/mcd-cooldown/dist/src/cli.js`，不看当前目录。

## 没有交互终端时怎么 init

`init` 在交互终端里问城市和关键词，用只读的 `query-nearby-stores` 列出门店，你输入序号选定；再用只读的 `query-meals` 列出这家店的菜单，你选常点的几项。查菜单时会带上下一个午饭或晚饭（默认 12:00 和 18:30，当天这两顿都过了就用明天的午饭），所以早上初始化选到的是正餐，不是当时正在卖的早餐。配置写入 `~/.mcd-cooldown/config.json`。接着问要不要在状态栏提醒午饭和晚饭，默认工作日 12:00 和 18:30。这一步不下单。

没有交互终端时，把选择写在参数里。`--store` 和 `--item` 先按编码匹配，对不上再按序号。`--item` 可以重复。门店和餐品都能对上时，只打印选定结果。还没给 `--item` 时，菜单默认只列前 20 项，并提示 `--menu-all` 可看全部、`--item <编码>` 可重复写入配置。对不上，或只给了城市和关键词时，仍会打出编号列表，不写配置。

```bash
mcd-cooldown init --city 上海 --keyword 南京西路 --store 门店编码 --item 餐品编码
```

没有 Token、只想看流程时，加上 `--mock`。那是样例门店，不会连接官方服务，也不会下单。

`setup claude` 把状态栏和 Stop hook 合并进 `~/.claude/settings.json`，命令里是这份安装的绝对路径。写入前先备份。已经合并过再跑一次不会重复添加。想先看 JSON：`mcd-cooldown setup claude --print`（`--dry-run` 相同，不写文件）。写完后重开 Claude Code，状态栏才会显示那一行短状态。

## Token 文件

`mcd-cooldown token` 把 Token 写到 `~/.mcd-cooldown/token`，权限 0600。交互终端里粘贴不会显示，也不会把 Token 打出来。非交互时从标准输入读，例如 `pbpaste | mcd-cooldown token`。`mcd-cooldown token --clear` 删除这个文件。

环境变量 `MCD_MCP_TOKEN` 优先于文件，但只对当前终端有效。从 IDE 启动的 Claude Code 读不到那个 export，状态栏和 Stop hook 会改读这份文件。程序拒绝把这份目录放到 git 仓库里面，避免 Token 被提交。

## doctor、到店方式和错误码

离线预览不连接麦当劳：`mcd-cooldown demo`，以及 `mcd-cooldown doctor --mock`。样例门店和价格不是官方实时数据。有 Token 之后，`mcd-cooldown doctor` 只做只读自检：检查 Token 有没有漏进项目文件，然后列出工具，并查询当前时间、活动日历和营养数据长度。它不查订单、不领券、不抽奖、不下单。加 `--city 上海 --keyword 南京西路` 可以再列一次附近门店；查到 0 家会告警并建议换关键词。到店自取（`beType` 为 1）没有 `beCode`。`beCode` 只有得来速（`beType` 为 5）、外送（`beType` 为 2）和企业团餐（`beType` 为 6）才需要，这三种之外不要传。门店不在营业时间时，上游错误码 `600057` 会说成「门店当前不营业，可换 24 小时门店或改用预约（reservationDate）」。早上核价遇到错误码 `60006`、并且还没到下一顿午饭或晚饭（默认 12:00 / 18:30，已写入配置的钟点优先）时，会说明现在还是早餐时段、保存的正餐还没开卖、饭点提醒会在饭点前核价，不必重新跑 `init`，并补一句：门店和常点已经就绪，下一顿饭点提醒前会核价，可用 `doctor --city` 再核对门店。已经在饭点附近、餐品仍然不可售时，才说「常点里有这个时段不卖的餐品（比如早餐款），重新跑 init 换一份」。`doctor` 和 `plan` 在连接官方服务时，如果门店编码仍是 `init --mock` 留下的 `SAMPLE-` 样例门店，会直接说明要换真实 Token 再跑 `init`，不会把 Token 打出来。
