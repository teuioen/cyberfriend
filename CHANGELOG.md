# 更新日志 v2.0
# 更新日期 2026-04-26

> 本次更新涵盖 16 项功能新增与修复。

---

## 修复

### 1. CLI 指令不改变激活信道
- **文件**: `src/index.ts`
- `lastActiveChannel = sourceChannel` 移至命令处理块之后执行
- 输入 `/help`、`/status` 等命令**不再**改变当前激活信道
- 只有发送普通消息才会更新激活信道

---

### 2. 任务列表显示具体内容与行动
- **文件**: `src/systems/scheduler.ts`
- `/tasks` 命令现在在紧凑视图显示任务说明
- 详细格式增加：`说明：...` 和 `触发行动：...`（若有行动标签）

---

### 3. 饥饿系统（会饿死）
- **文件**: `src/database/db.ts`、`src/systems/health.ts`、`src/core/actionExecutor.ts`、`src/core/promptBuilder.ts`、`src/config/types.ts`、`config/app.yaml.example`
- `health` 表新增 `hunger` 字段（默认 80/100），通过迁移自动添加，不影响现有数据
- 每次心跳饥饿值减少（默认 -2，可配置 `hungerDecayPerTick`）
- 饥饿值归零后持续扣血并触发"饥饿"病状
- 健康状态提示词新增饥饿值显示：`饥饿值:XX/100`
- **`<USE item="物品名"/>`** 取代旧的 `SHOP_USE`：使用背包物品；物品若带 `tags: [食物]`（或 effects.hunger）则自动恢复饥饿值，无需独立 `<EAT>` 标签；`SHOP_USE` 保留为向后兼容别名
- `/status` 命令新增 `🍽️ 饥饿` 行，与健康/疲惫并排显示
- **新增配置项**（`app.yaml.example`）：
  ```yaml
  health:
    hungerDecayPerTick: 2.0      # 每次心跳饥饿值减少量
    hungerDamageThreshold: 0     # 低于此值开始扣血
  ```

---

### 4. 商店商品按需查询（支持标签过滤）
- **文件**: `src/systems/shop.ts`、`src/core/promptBuilder.ts`、`src/core/actionExecutor.ts`、`src/core/actionParser.ts`
- `ShopItem` 新增可选字段 `tags?: string[]`（向后兼容），例如 `tags: [食物, 饮料]`
- `getItemNames(tag?: string)` 支持按标签过滤；未传 tag 则返回全部
- 商品列表**不再**直接注入系统提示词（避免商品多时 token 浪费）
- 提示词改为：`【商店】使用 <SHOP_LIST/> 查询商品；使用 <SHOP_BUY name="品名"> 购买`
- 新增行动标签 `<SHOP_LIST/>` 或 `<SHOP_LIST category="食物"/>` — AI 主动查询时，商品名列表以系统消息形式返回给 AI（触发二次 AI 调用）
- 这样 AI 只在需要购买时才请求列表，节省每次对话的 token

---

### 5. TaskWatcher 日志刷屏修复
- **文件**: `src/core/heartbeat.ts`
- 新增字段 `private lastAiBusyLogTime = 0`
- "AI 正忙，任务延迟" 日志增加节流：60 秒内最多输出一次

---

### 6. 工具调用系统（沙盒）
- **文件**: `src/core/tools.ts`（新建）、`src/core/actionExecutor.ts`、`src/core/promptBuilder.ts`、`src/config/types.ts`、`config/app.yaml.example`
- 支持 **8 种工具**（均在工作区沙盒内运行，路径越界会被拒绝）：
  | 工具名 | 参数 | 说明 |
  |---|---|---|
  | `read_file` | `path=路径` | 读取工作区文件 |
  | `write_file` | `path=路径, content=内容` | 写入工作区文件 |
  | `edit_file` | `path=路径, old_str=旧, new_str=新` | 替换文件内容 |
  | `glob_files` | `pattern=*.txt` | 按模式匹配文件名 |
  | `grep_files` | `pattern=词, path=可选目录` | 搜索文件内容 |
  | `list_files` | `path=可选目录` | 列出目录文件 |
  | `shell` | `cmd=命令` | 执行命令行（需 `allowShell: true`）|
  | `fetch` | `url=https://...` | 获取网页（需 `allowNet: true`）|
- AI 可通过 `<ENABLE_TOOLS/>` 行动标签为**本次会话**临时启用工具；使用 `<ENABLE_TOOLS state="off"/>` 关闭
- 若 `tools.enabled: true`（配置级永久启用），提示词中不再显示 `<ENABLE_TOOLS/>` 入口；启用后显示当前可用工具列表及 `<ENABLE_TOOLS state="off"/>` 关闭入口
- **工具文档按需注入**：工具未启用时提示词只显示 `<ENABLE_TOOLS/>`；启用后才显示完整工具列表（含 allowShell/allowNet 条件）
- 工具结果以系统消息形式注入上下文，触发**第二次 AI 调用**使 AI 看到结果
- **新增配置项**（`app.yaml.example`）：
  ```yaml
  tools:
    enabled: false
    workspace: data/workspace  # 沙盒工作目录（相对 cwd）
    allowShell: false
    allowNet: false
    shellTimeout: 10000
  ```

---

### 7. `/memories` 支持分页与全量查看
- **文件**: `src/commands.ts`
- `/memories` — 第 1 页（默认 10 条/页）
- `/memories all` — 全部记忆（长/短期分类展示）
- `/memories <页码>` — 翻页
- `/memories search <关键词>` — 搜索记忆
- 底部显示总数与翻页提示

---

### 8. `--active-channel` 强制信道参数
- **文件**: `src/index.ts`
- 新增启动参数 `--active-channel <信道名>`
- 启动时强制设置激活信道（大小写不敏感匹配）
- 名称不匹配时输出警告并继续默认行为
- 示例：`npm start -- --active-channel wechat`

---

### 9. CLI 时间线修复（其他信道消息镜像）
- **文件**: `src/index.ts`
- CLI 镜像显示其他信道 AI 回复时，增加 `cli.showTimeMarkerIfNeeded()` 调用
- 长时间无消息后的时间分隔线现在正确显示

---

### 10. 虚拟币改名为"元"
- 所有用户可见文本"虚拟币"/"虚拟货币" → **"元"**
- 涉及文件：`shop.ts`、`commands.ts`、`actionExecutor.ts`、`promptBuilder.ts`、`heartbeat.ts`、`work.ts`、`userWork.ts`、`relationship.ts`、`app.yaml`、`app.yaml.example`
- 内部变量名（`userCurrency`、`aiCurrency`、`dailyCurrencyUser` 等）**保持不变**

---

### 11. 心跳感知用户不活跃时长
- **文件**: `src/index.ts`、`src/core/heartbeat.ts`
- 新增 `lastUserInteractionTime` 变量追踪用户最后一次发消息时间
- 心跳提示词注入不活跃信息：
  - < 5 分钟：`用户最近 X 分钟前互动过`
  - 5–60 分钟：`用户已有 X 分钟未互动，可能暂时离开`
  - > 60 分钟：`用户已有 X 小时未互动，可能长时间离开`
  - 从未互动：`尚未与用户互动过`
- AI 可据此判断是否发送重复内容

---

### 12. 硬编码 shop.yaml 路径修复
- **文件**: `src/index.ts`、`src/config/types.ts`、`config/app.yaml.example`
- 原来硬编码的 `path.join(process.cwd(), 'config', 'shop.yaml')` 改为读取配置
- 新增 `AppConfig.shopConfigPath?: string`（相对配置目录，默认 `shop.yaml`）
- 支持绝对路径和相对路径

---

## 新功能

### 13. Skills 技能系统
- **文件**: `src/systems/skills.ts`（新建）、`src/core/actionExecutor.ts`、`src/core/promptBuilder.ts`、`src/index.ts`、`config/skills.yaml.example`（新建）
- 技能通过 `config/skills.yaml` 配置，自动加载
- 每个技能可定义：名称、描述、额外提示词（`prompt`）、预定义行动列表（`actions`）
- AI 使用 `<SKILL name="技能名"/>` 调用技能；技能 `prompt` 会注入下次对话上下文
- 技能列表自动注入 AI 提示词
- 参考 `config/skills.yaml.example` 配置示例

---

### 14. 快速配置向导 `--onboard`
- **文件**: `src/utils/onboard.ts`（新建）、`src/index.ts`
- 启动参数 `--onboard` 进入交互式首次配置向导
- 向导步骤：AI 角色设定 → API 配置（baseUrl/key/model）→ 数据库路径
- 自动生成 `character.yaml` 和 `app.yaml`
- 已有配置时提示是否覆盖
- 运行方式：`npm start -- --onboard`

### 15. 梦境生成多样化
- **文件**: `src/core/ai.ts`、`src/core/heartbeat.ts`
- `generateDream` 新增 `freeform` 参数（默认 `false`）
- 40% 概率生成与现实无关的自由想象梦境，使梦境不总是基于历史记忆
- 自由梦境提示词引导生成幻想世界、荒诞场景、象征性意象


### 16. 工具调用完整上下文持久化
- **文件**: `src/database/db.ts`、`src/core/context.ts`、`src/index.ts`
- `Message` 接口新增 `toolCalls?: string` 和 `toolCallId?: string` 字段（JSON 字符串）
- 数据库表 `messages` 自动迁移：新增 `tool_calls TEXT` 和 `tool_call_id TEXT` 两列
- `saveMessage` / `getMessages` / `getAllUncompressedMessages` 同步更新以读写新列
- `context.buildChatHistory()` 重建完整工具调用链（`assistant(tool_calls)` → `tool` → `assistant`），不再丢失中间步骤
- `context.addToolMessages()` 新增方法，将工具调用轮次写入数据库
- `compress()` 将 `tool` 角色映射为 `user` 以兼容摘要生成模型
- 下轮对话时 AI 能看到完整工具调用历史，不再需要文字注释补充

---


## 帮助文档更新

- **文件**: `src/commands.ts`（`/help` 命令）
- 新增"记忆查看"分区，详细列出 `/memories` 所有用法
- 新增"启动参数"分区，说明 `--active-channel` 和 `--onboard`
- 更新 `/memories` 简短说明

---

## 配置文件更新

- `config/app.yaml.example` 新增：
  - `health.hungerDecayPerTick`、`health.hungerDamageThreshold`
  - `shopConfigPath`（商店配置文件路径）
  - `tools` 完整配置块（注释状态，按需启用）
  - 技能系统说明注释
  - `economy` 注释改为"余额"

---

## 文件清单

| 文件 | 变更类型 |
|---|---|
| `src/index.ts` | 修改 |
| `src/commands.ts` | 修改 |
| `src/core/ai.ts` | 修改 |
| `src/core/actionExecutor.ts` | 修改 |
| `src/core/actionParser.ts` | 修改 |
| `src/core/heartbeat.ts` | 修改 |
| `src/core/promptBuilder.ts` | 修改 |
| `src/core/tools.ts` | **新增** |
| `src/database/db.ts` | 修改 |
| `src/systems/health.ts` | 修改 |
| `src/systems/scheduler.ts` | 修改 |
| `src/systems/shop.ts` | 修改 |
| `src/systems/skills.ts` | **新增** |
| `src/systems/work.ts` | 修改 |
| `src/systems/userWork.ts` | 修改 |
| `src/systems/relationship.ts` | 修改 |
| `src/config/loader.ts` | 修改 |
| `src/config/types.ts` | 修改 |
| `src/channels/cli.ts` | 修改 |
| `src/utils/onboard.ts` | **新增** |
| `config/app.yaml.example` | 修改 |
| `config/skills.yaml.example` | **新增** |