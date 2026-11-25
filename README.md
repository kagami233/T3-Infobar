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
