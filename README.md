# TokenLens · Token 用量浮窗

> 给 DeepSeek Harness 装一只贴在桌面上的「用量仪表」：上下文、连接器、子智能体各占多少，
> 每一轮任务上下行花了多少，最近 14 天怎么走的，一眼看完。纯本地、零上传。

![预览](docs/preview-light.png)

## 它解决什么问题

Harness 自己会把用量算清楚，但这些数字藏在会话状态里，你得点开、翻页、心算。
TokenLens 把它们抠出来，做成一个**永远置顶的小窗**：

- **模块归因**：上下文（系统提示 + 消息正文 + 工具定义）、连接器、子智能体、工具执行，各自占多少、几成。
- **任务上下行**：第几轮、上行输入多少、下行输出多少，按轮次排开。
- **上下文水位**：当前 surface 占上下文窗口的百分比，以及系统／工具／消息的拆分。
- **每日统计**：最近 14 天的堆叠柱状图（未缓存输入／输出／缓存命中），带合计、日均、峰值。
- **紧凑模式**：折叠成一条 52px 高的横条，只留今日总量，不挡视线。

三种打开方式，随场景挑：

| 形态 | 命令 | 说明 |
| --- | --- | --- |
| 浮窗 | `npm start` | 无边框、置顶、可拖拽缩放的独立窗口 |
| 紧凑条 | 点标题栏 `⌃` | 收成一条，托盘/快捷键随时展开 |
| 面板 | `npm run panel` | 起一个本地 HTTP 面板，可嵌进 harness web profile 或任意 iframe |

## 快速开始

```bash
# 1) 环境自检（确认能读到 harness 数据）
node scripts/doctor.js

# 2) 启动浮窗
npm start

# 3) 数据太少？先看示例面板
npm run demo
```

`npm start` 会按顺序找一个能用的 Electron 运行时：

1. `TOKENLENS_ELECTRON` 环境变量指定的路径
2. 项目内 `node_modules/electron`
3. **DeepSeek Harness 自带的 Electron**（装了 harness 就不用再下载）
4. `PATH` 上的 `electron`

也就是说，机器上装了 Harness，就**不需要 `npm install`**。

## 快捷键与托盘

| 操作 | 方式 |
| --- | --- |
| 显示 / 隐藏浮窗 | `Ctrl + Alt + T`，或点托盘图标 |
| 立即刷新 | 标题栏 `⟳`，或 `Ctrl + R` |
| 折叠 / 展开 | 标题栏 `⌃` / 紧凑条 `⌄` |
| 刷新间隔 | `⋯` → 2s / 5s / 15s / 暂停 |
| 置顶开关 | `⋯` → 窗口 → 置顶 / 普通 |
| 切换数据源 | `⋯` → 数据源 → 本机 / 示例 |
| 会话切换 | 底部下拉框 |
| 开机自启 / 任务栏显示 / 打开数据目录 | 托盘右键菜单 |

窗口位置、置顶状态、刷新间隔、当前会话都会记住（`%APPDATA%\tokenlens\config.json`）。

## 数据从哪来

全部读取本地文件，**不发任何网络请求**：

| 来源 | 路径 | 用途 | 口径 |
| --- | --- | --- | --- |
| 会话投影缓存 | `~/.dsh/storages/session_projcache/sessions/session-*.json` | 会话标题、模型、总用量、上下文拆分 | **准数**（harness 官方口径） |
| 会话事件流 | `~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd` | 逐轮用量、工具调用、时间戳 | **准数**（与总量逐 token 对齐） |
| 每日历史库 | `%APPDATA%\tokenlens\history.json` | 跨天累积的日统计 | 由上面两者按天汇总 |

事件流是**追加写**的 zstd 多帧文件，每段 append 都是一个独立 frame。
Node 的 `zlib.zstdDecompressSync` 只解第一帧，直接读会丢 90% 以上的数据——
TokenLens 按 zstd magic 扫描逐帧解压，这也是它能还原逐轮明细的关键。

### 准数 vs 估算

harness 明确给出的数字一律照抄，不猜：

- 总用量：`tokenUsage.totals`（未缓存输入 / 缓存命中 / 输出 / 缓存写入）
- 逐轮用量：`assistant/message.data.usage`，累计值与总量逐 token 一致
- 上下文：`contextBreakdown.breakdown`（系统 / 工具定义 / 消息正文）、`contextPressure`

harness 没给 token 数的部分（工具 schema 体积、工具返回内容），用 CJK 感知的字符估算：
中文约 1.5 字/token，拉丁约 3.5 字/token。**面板上带 `※` 的模块即为归因估算**，不会伪装成准数。

### 模块归因规则

- **上下文** = 系统提示 + 消息正文 + 未被调用工具的 schema 占用（这些确实躺在上下文里）
- **连接器** = 连接器类工具（`mcp__*`、docs / meeting / mail / 各类 SaaS 连接器）的 schema + 返回内容
- **子智能体** = 子智能体 / 团队类工具调用与委派会话的消耗
- **工具执行** = 内置工具（shell / 读写 / 搜索等）的返回内容

只有当某模块真的被调用时，它的 schema 才计入该模块，否则回流到上下文——
避免出现「子智能体 3000 tokens，但一次都没用过」这种假象。

## 兼容性

对着 **DeepSeek Harness Desktop 0.2.1-rc.2 / 会话格式 v4** 开发与验证。
读取逻辑对未知事件类型、缺失字段、半写文件一律容错跳过，因此小版本升级不会崩，
最坏情况是某些面板降级为空。

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（x64）。macOS / Linux 逻辑上也可跑，未做验证 |
| Node | ≥ 22.15（需要 zstd API）。低于此版本会降级为「只显示会话准数」 |
| Electron | 建议 30+；本机实测 harness 自带 43.3.0（Node 24.18.1） |
| Harness | 0.2.x（session format v4） |

## 开发者

```
src/
  main/
    main.js          主进程：浮窗、托盘、快捷键、IPC
    collector.js     采集器：projcache 解析 + zstd 多帧事件流 → 会话模型
    history.js       历史库：每日用量跨天累积（按天取大值，重复采集不翻倍）
    service.js       视图模型：模块占比、逐轮上下行、上下文水位
    demo.js          示例数据（固定种子，刷新不跳变）
    panel-server.js  面板模式的 HTTP 服务（仅监听 127.0.0.1）
  preload/preload.js 最小 IPC 面（contextIsolation 开启，无 Node 直通）
  renderer/          纯 CSS/DOM 图表，无前端框架、无 CDN
scripts/
  start.js           运行时探测 + 启动
  serve.js           无 Electron 的面板模式
  doctor.js          环境自检
  make-icon.js       图标生成（纯 Node 写 PNG）
  pack.js            打包 zip（纯 Node 写 ZIP）
```

常用命令：

```bash
node scripts/doctor.js          # 看数据链路是否通
npm start -- --dev              # 开 DevTools
npm start -- --shot=out.png     # 截图自测（自动关硬件加速）
npm run panel                   # 面板模式，默认 http://127.0.0.1:4317
npm run pack                    # 产出 dist/tokenlens-<version>.zip
```

## 隐私

- 只在本地读 `~/.dsh` 下的会话文件，写 `%APPDATA%\tokenlens` 下的配置与历史库。
- 无遥测、无网络请求、无账号。
- 面板模式只绑定 `127.0.0.1`，不监听外网地址。

## License

MIT © 2026 柒仔
