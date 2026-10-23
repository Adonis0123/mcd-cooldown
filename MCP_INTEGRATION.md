# MCP 集成说明

本项目调用麦当劳中国官方 MCP Server。它不是麦当劳官方产品，也不代用户支付。

## 服务

| 项 | 值 |
|---|---|
| 服务 | 麦当劳 MCP Server |
| 地址 | `https://mcp.mcd.cn` |
| 传输 | Streamable HTTP，`POST` JSON-RPC |
| 协议版本 | 客户端向官方服务发送 `2025-06-18` |
| 鉴权 | 请求头 `Authorization: Bearer <Token>` |
| Token 来源 | 环境变量 `MCD_MCP_TOKEN`，或本机 `~/.mcd-cooldown/token` |
| 限流 | 官方说明为每个 Token 每分钟 600 次；超出时 HTTP 429 |

官方在未授权时返回 HTTP 401，正文是纯文本「当前鉴权码不存在或已失效!」，不是 JSON。`doctor` 会原样说明这一类失败，但不会打印 Token。

Token 只会出现在网关发往 `https://mcp.mcd.cn` 或本机回环地址的请求头里。查询参数、重定向和其他主机都会被拒绝，避免把 Token 带到别处。模型能看到的 MCP 配置里没有 Token。

## 两层调用

1. **透传。** `mcd-cooldown guard` / `serve` 把客户端的 `tools/list` 和只读 `tools/call` 转发给官方服务，并把官方 schema 原样交给客户端。写工具的描述会被加上拦截说明。
2. **程序自己发起的调用。** `init`、`doctor`、`plan`、`confirm`、`watch` 使用同一套客户端，按下面的流程调用。`setup claude` 不调用麦当劳，只改本机 `~/.claude/settings.json`。

写工具默认不转发。本机执行 `mcd-cooldown confirm <请求号>` 之后才会转发一次。重复确认不会再次提交。

## 工具分类

分类以 2026-10-11 对 `https://mcp.mcd.cn` 的只读实测为准，当时共 35 个工具。官方仓库 [M-China/mcd-mcp-server](https://github.com/M-China/mcd-mcp-server) 较早列出的 33 个名字里，`query-partystore-date` 和 `query-partystore-session` 已改名为 `query-party-store-date`、`query-party-store-session`，并多了只读的 `query-promotions`（企业团餐满减满折，入参含 `storeCode`、`beCode`、`orderType=2`、`beType=6`）和 `query-survey-coupon`（按订单查满意度答卷和关联奖券，涉及个人订单，`doctor` 不会调用）。运行时若上游再增加工具，名称里带 create / cancel / bind / draw 等写入含义的，网关也会先拦住。`doctor` 会列出上游有、目录里没有的工具名。

### 只读，默认可转发

`now-time-info`、`list-nutrition-foods`、`campaign-calendar`、`query-nearby-stores`、`delivery-query-stores`、`delivery-query-addresses`、`query-meal-assistance`、`query-meals`、`query-meal-detail`、`query-store-coupons`、`available-coupons`、`query-my-coupons`、`query-my-account`、`calculate-price`、`query-order`、`order-list`、`mall-points-products`、`mall-product-detail`、`mall-order-list`、`mall-order-detail`、`query-lottery-info`、`query-my-prizes`、`query-party-city`、`query-party-store`、`query-party-store-date`、`query-party-store-session`、`query-promotions`、`query-survey-coupon`。

`calculate-price` 只核价，不创建订单。官方说明里，它的金额字段是以分为单位的整数。网关展示前会除以 100。

### 有副作用，默认拦截

| 工具 | 拦住之后 |
|---|---|
| `create-order` | 先调用 `calculate-price`。超过单笔或当日金额上限则直接拒绝。否则只保存待确认请求 |
| `cancel-order` | 等本机确认，避免模型把订单取消掉 |
| `auto-bind-coupons` | 等本机确认后才领取 |
| `draw-lottery` | 等本机确认后才消耗积分或次数 |
| `mall-create-order` | 等本机确认后才兑换 |
| `delivery-create-address` | 等本机确认后才提交姓名、手机号和地址 |
| `party-order-create` | 等本机确认。主题活动订单不能用餐饮核价接口估算金额，所以不计入餐饮金额上限，但计入每日非餐饮写操作次数 |

金额上限默认单笔 80 元、当日 150 元，份数默认不超过 12。这些是本地配置，用来避免误操作，不是官方限额。

## 本程序主动调用的流程

### `doctor`：只读自检

配置好 Token 后运行。顺序是：

1. `initialize`
2. `tools/list`
3. `now-time-info`，参数 `{}`
4. `campaign-calendar`，参数 `{}`
5. `list-nutrition-foods`，参数 `{}`。只报告正文长度，不把营养全文打出来
6. 只有同时传入 `--city` 和 `--keyword` 时，才调用 `query-nearby-stores`，参数为 `searchType: 2`、`beType: 1` 加上城市和关键词。门店列表在返回的 `data` 数组里。会写出每家的 `storeCode`、名称、是否营业和营业时间；到店自取没有 `beCode`。0 家门店时这一项不通过，并提示换关键词

不会调用订单、地址簿、券包、积分、领券、抽奖、兑换或下单。门店不营业时上游错误码 `600057` 会转成「门店当前不营业，可换 24 小时门店或改用预约（reservationDate）」。连接官方服务时，如果本机 `storeCode` 仍是 `init --mock` 留下的 `SAMPLE-` 样例门店，`doctor` 直接失败并说明要用真实 Token 重新跑 `init`，不把 Token 打出来，也不继续请求上游。

### `init`：写入门店和常点餐品

交互终端里询问城市、关键词、门店序号和常点餐品；非交互环境使用 `--city`、`--keyword`、`--store`、`--item`。还没给 `--item` 时，菜单默认只列前 20 项，`--menu-all` 才列出全部。只调用：

1. `query-nearby-stores`，参数 `searchType: 2`、`beType: 1`、`city`、`keyword`
2. `query-meals`，参数 `storeCode`、`beType: 1`、`orderType: 1`，以及 `reservationDate`（`yyyy-MM-dd HH:mm`，取下一个午饭或晚饭，默认 12:00 / 18:30，已经过了的不用）。到店自取不传 `beCode`。这样早上初始化不会把当时的早餐菜单存成常点

不调用 `calculate-price`、`create-order` 或其他写工具。选中的门店和餐品编码写入本机 `config.json`。门店和餐品已经能从参数对上时，终端只打印选定结果。

### `plan`：按额度恢复时间准备一单核价

1. 从 Claude Code 状态栏留下的本地记录里读取 5 小时或 7 天窗口的 `resets_at`
2. 用北京时间把「额度恢复」倒推 `prepMinutes`（默认 20 分钟）。核价成功并写下待确认请求时，得到建议确认时间，到店自取是为了让人起身活动一下。核价没成功、没有待确认请求时，不说确认时间，只留「起来活动一下」
3. 调用 `now-time-info`
4. 若本机配置了门店和常点餐品，调用 `calculate-price`。参数来自配置里的 `storeCode`、`beType`、`orderType` 和 `items`。`beCode` 只在得来速（5）、外送（2）和团餐（6）时附上；到店自取（1）不传
5. 核价成功且未超限时，在本机写下一条 `create-order` 待确认请求。此时还没有调用 `create-order`。门店不营业（错误码 `600057`）时只说明原因，不生成待确认单。错误码 `60006` 不把上游原文甩给用户：还没到下一顿午饭或晚饭时，只留一句短话，写明下一顿钟点，例如「早餐时段正餐还没开卖，午饭 12:00 前会提前核价」；已经在饭点附近仍然不可售，才说明重新跑 `init`。连接官方服务时，样例门店编码（`SAMPLE-`）会在核价前被拒绝

23:00 到次日 06:00（按配置时区，默认北京时间）只保留核价，不生成待确认单，并提示先休息。这个时段要生成待确认单或确认提交，都必须额外加上 `--allow-quiet`。

没有配置常点餐品时，只提醒，不猜测餐品。

### 饭点：按想吃的时间倒推，仍然只核价

午饭默认 12:00，晚饭默认 18:30，工作日开启，周末可另开。时区默认 `Asia/Shanghai`，可以改成用户本地时区。状态栏脚本本身不联网。Stop hook 在提醒窗口里最多为每一顿调用一次：

1. 用配置里的目标时间和预计分钟算出窗口。预计分钟优先取本机已经记下的 `calculate-price` 结果，没有则用 `meals.prepMinutes`（默认 20）
2. 若配置了门店和常点餐品，调用 `calculate-price`。参数与 `plan` 相同
3. 从返回里读取预计分钟。识别的字段包括 `expectMinutes`、`deliveryTime`、`makeTime` 以及带「分钟」的字符串。读不到就继续用默认值。金额字段不会被当成时间
4. 未超限时在本机保存一条 `create-order` 待确认请求。此时不调用 `create-order`

状态栏只有在已经核好价、并且有待确认请求时，才写「现在确认，约 12:05 可取」或「现在确认，约 12:05 送达」，并给出 `confirm` 命令。读不到 Token 时改为提示把 Token 留在本机；核价没成功时提示运行 `plan`。`ate`、`later`、`skip` 只改本机记录，不调用麦当劳。确认成功的那一顿不再提醒。23:00 到次日 06:00 仍只提示休息，饭点提醒不覆盖这条规则。额度窗口和饭点叠在一起时，hook 只说一次，状态栏也只有一条。

系统通知默认关闭。打开后也只由这次 hook 尝试发送，没有常驻进程。

### `confirm`：用户确认后才下单

1. 再次调用 `calculate-price`。读不到整数金额，或金额超过上限，就拒绝，不调用 `create-order`
2. 通过之后才转发当初拦住的那一次工具调用
3. 若是 `create-order` 并且返回了订单号，把状态写入本机，供状态栏显示

### `watch`：取餐进度

调用 `query-order`，参数 `{ orderId }`。状态栏脚本本身不联网，只读这次写入的本地缓存。

### 网关本地工具

`cooldown-status` 不是麦当劳的工具。它只读本机的额度、核价和取餐缓存，方便模型解释状态栏。它不会访问官方写接口。

## 样例服务

仓库里的 `mcd-cooldown mock` 和测试使用的样例服务，是按公开文档里的工具名和返回形状做的合成数据。里面的门店、订单号和价格都是示例，不是某一次真实账户的录制，也不能当作官方实时菜单或价格。没有 Token 时，`doctor --mock`、`plan --mock` 和单元测试走这套服务，用来验证拦截、确认和状态栏。

配置 Token 之后，同一套客户端会把只读自检发到 `https://mcp.mcd.cn`。

## 业务价值

编码助手的额度用完，或者写到了该吃饭的时候，往往也是该起身活动一下的时候。这个网关把额度倒计时和午饭晚饭接在同一条状态栏上：先按出餐时间准备一份适量的核价；真正会产生订单、扣积分、领券或新增地址的调用，则在协议层停住，换一个客户端也仍然有效。用户自己确认后才提交，支付链接交给用户本人打开。
