# T3-InfoBar (Gemini + Codex 双引擎状态条皮肤 & 动态 HUD)

仿照 [Codex-InfoBar](https://github.com/kagami233/Codex-InfoBar) 为 **T3 Code** 定制的双引擎（**Google Gemini / Antigravity** + **OpenAI Codex**）状态条皮肤与实时会话指标组件。

## 1. 双引擎自动切换指标

| 槽位 | Google Gemini 引擎 (`transcript.jsonl`) | OpenAI Codex 引擎 (`~/.codex/sessions`) |
| --- | --- | --- |
| **① 平均输出速度** | 当前/最近回合累计 `output_tokens` ÷ 回合耗时 | 当前/最近回合累计 `output_tokens` ÷ 回合耗时 |
| **② 命中缓存** | `cache_read_tokens / (input_tokens + cache_read_tokens)` | `cached_input_tokens / input_tokens` |
| **③ 压缩次数** | 会话内 `/compact` 或上下文压缩完成次数 | 手动与自动压缩完成次数 |
| **④ 上下文余量** | `1,000,000 (1M)` 减去当前总占用 token | 模型上下文窗口减去已用 token |
| **⑤ 剩余压缩余量** | 按 **800k (80%) 自动压缩阈值** 估算剩余百分比 `≈%` | 按项目配置与近期压缩记录校准的 `≈%` |
| **⑥ 套餐圆环 & 倒计时** | T3 当前连接提供的 5 小时及每周剩余额度（`<20%` 变红）与重置倒计时 | T3 当前连接提供的套餐剩余额度（`<20%` 变红）与重置倒计时，或更早的重置卡到期倒计时 |
| **⑦ 右侧专属槽位** | **模型与思考档位徽章**（如 `Argon·High` / `Neon·XHigh`） | **可用重置卡数量**（如 `3张`） |

## 2. 两种工作模式（无缝协同）

1. **T3 原生主题皮肤（零侵入 / 免重启，含输入框底部内嵌 SVG 状态条）**
   - 主题 ID：`codex-infobar`（源文件 [`theme/codex-infobar.json`](./theme/codex-infobar.json)）。
   - 使用 `[data-slot="composer-host"]:not(:has(#t3-metrics-hud))::after` 在 T3 输入框底部内嵌 7 项指标的矢量状态条；当 CDP 动态组件 `#t3-metrics-hud` 挂载后，自动隐藏 CSS 静态条。
2. **CDP 动态注入组件（每 2 秒实时刷新 + 悬停详情 + 双引擎自动切换）**
   - [`src/renderer.js`](./src/renderer.js) 自动挂载至 T3 输入框容器 `[data-slot="composer-host"]` 或 `[data-chat-composer-form]`。
   - 通过 T3 本地会话绑定读取对应引擎的原生日志；原生 Codex 使用 `~/.codex`，其他 Codex 连接使用各自的 shadow 目录。
   - 套餐额度读取当前连接的 T3 用量记录。Gemini 按模型匹配五小时及每周额度池；单个会话的 token 数仅用于会话统计。
   - Gemini 圆环旁仅显示倒计时。两种引擎的用量悬停文案均为 `套餐剩余：{剩余百分比}%；重置剩余时间：{倒计时}`；重置卡到期悬停仅显示到期日期时间与 `（北京时间）`。
   - 未提供额度时显示 `—`，重置时间过后显示“等待更新”。共享 Codex 连接不支持数值额度时提供“查看用量”链接。

### 远程会话

动态 HUD 支持 T3 的 `环境 ID / 会话 ID` 路由及远程导入会话。远程数据读取 T3 已同步到当前界面的统计，无需复制原始对话或登录凭据。

- 上下文占用和窗口上限优先使用远端 T3 报告值；切换引擎或新回合尚未报告用量时，可使用同一原生绑定的远端日志最近记录。提供输入及缓存 token 时显示缓存命中率。
- 套餐额度优先从该远程环境、对应连接读取。确认两端共享同一额度池后，可显式绑定本地账号作为缺失额度的参考；重置卡仍只读取远程连接自身的数据。
- T3 的最新请求输出 token 无法代表整轮累计输出，因此未取得完整统计时，输出速度、压缩次数和压缩余量显示 `—`。
- 缓存按环境和会话隔离；远程断开或没有匹配数据时，不读取本机同名会话作为替代。

确认远程和本地使用同一账号、共享套餐额度后，可运行 `share-quota` 配置引用。下面的参数中，远程环境及连接 ID 使用 T3 当前连接对应的 ID，本地连接使用本机对应的 provider instance ID：

```sh
node src/cli.mjs share-quota --remote-environment "$REMOTE_ENVIRONMENT_ID" --remote-provider "$REMOTE_PROVIDER_ID" --local-provider antigravity --provider gemini
node src/cli.mjs share-quota --remote-environment "$REMOTE_ENVIRONMENT_ID" --remote-provider "$REMOTE_CODEX_PROVIDER_ID" --local-provider codex --provider codex
```

绑定保存在本机 InfoBar 状态目录的 `shared-quota.json`，可通过 `--shared-quota` 指定其他文件。采集器读取 T3 本机用量缓存，并按远程模型筛选对应额度池；引用仅影响套餐余量与重置时间。配置会固定本地账号身份，换账号后需要重新运行绑定命令。无绑定、记录无效或过旧时保持未知。额度悬停文案保持简洁，不增加来源或缓存文字。

Gemini 额度每分钟通过对应环境的 T3 接口请求刷新，每 15 秒读取一次状态。接口未提供新记录时，不会把读取时间当作额度更新时间：超过 90 秒的百分比显示为 `—`，保留已知重置倒计时。远端原生采集器识别当前会话的结构化 `usage_limit` 失败；当错误的重置时间与额度窗口匹配时，该窗口显示 0%，直至重置或取得更新的恢复记录。无法确定窗口时只显示倒计时，不推算周余量。

macOS 原生采集器还可每分钟通过 Antigravity 当前登录状态直接读取 Google 额度接口，优先显示最新的 5 小时和周额度。安装器仅为已确认共享账号的 Gemini 连接启用这条路径，并固定 Google 账号指纹；账号不匹配、登录过期或接口失败时不继续使用旧百分比。登录信息只在远端进程内使用，不写入统计文件或传回本机。

### 读取远端原生日志

Mac mini 等 macOS 远端可以运行原生日志采集器，补充输出速度、缓存命中率、已记录的压缩次数和估算压缩余量。当前连接需允许文件写入和终端操作，并在远端 T3 中将 `~/Library/Application Support/T3-InfoBar-Agent` 注册为项目目录（可以归档该项目）。这是 T3 文件接口的目录授权要求。在运行 T3 桌面的本机执行：

```sh
node src/install-remote.mjs --environment "$REMOTE_ENVIRONMENT_ID" --thread "$REMOTE_APP_THREAD_ID"
```

远端需有 Node 22.17 或更新版本；Apple Silicon Mac 已安装的 Node 版本较旧时，安装器会下载并校验官方 Node 24.11.1，在采集器目录内独立使用，不修改系统 Node。安装器先验证远程会话日志，再安装用户级 LaunchAgent `com.t3infobar.metrics`。采集器位于远端 `~/Library/Application Support/T3-InfoBar-Agent`，每两秒将统计结果写入 `snapshots.json`。本机沿用 T3 的认证文件读取接口获取这些统计，数据不包含对话正文、工具参数或登录凭据。

本机状态目录的 `remote-metrics.json` 记录统计源，`attach --remote-metrics` 可指定其他配置文件。统计超过 30 秒未更新、会话原生绑定不匹配或读取失败时，恢复为 T3 已同步的基础字段。压缩次数仅统计可识别的日志事件，压缩余量保留 `≈` 估算标记。

远端采集器第 5 版支持按窗口自动登记。打开或切换到已绑定原生日志的远程会话后，桌面端会在该环境的 `registrations/` 目录更新这个会话自己的登记文件。窗口每 30 秒续期，离开约两分钟后暂停该会话的动态采集，重新打开会自动恢复。每轮优先采集最近打开的会话，并包含安装时固定的会话，合计最多 64 个。已有远端采集器可用上面的安装命令升级。

在远端停止采集器可执行：

```sh
launchctl bootout "gui/$(id -u)/com.t3infobar.metrics"
```

## 3. 常用命令

```sh
cd T3-Infobar

# 1. 运行双引擎单元测试
npm test

# 2. 读取当前或指定会话的真实快照（支持 --engine auto|gemini|codex）
node src/cli.mjs snapshot

# 3. 将最新真实会话指标同步生成至 T3 主题文件
npm run theme

# 4. 启动本地交互预览页面
npm run preview

# 5. 通过 CDP 动态挂载到开启了调试端口的 T3 Code 客户端（默认端口 9342）
# open -a "T3 Code" --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9342
node src/cli.mjs attach --port 9342 --position inside
```
