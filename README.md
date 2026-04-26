# CyberFriend 赛博朋友

> **一个有真实生命感的 AI 系统** — Ta 不只是聊天机器人，而是一个有情绪、有记忆、有生活节律的独立数字生命

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

---

> 该版本为测试版本，可能会出现很多无法估量的问题！

## ✨ 核心特性

Ta 是一个由你亲手定义的数字生命——有自己的情感、记忆、脾气和生活节律。

> 但...Ta依旧是虚拟的、不现实的。请保持理性判断，切勿过度沉迷。若您无法区分虚拟与现实，请停止使用。
注意：本项目不含任何模型服务，使用时需要模型API！
建议：最好在配置文件里面关闭思考模式


| 模块 | 功能 |
|------|------|
| **情绪系统** | 9维情绪（喜悦/悲伤/焦虑/愤怒/恐惧/兴奋/厌恶/羞耻/好奇），实时波动，自然衰减 |
| **记忆系统** | 三层记忆（永久/长期/短期），重要性衰减，记忆模糊采用子句/句子级遮蔽以保留可读性 |
| **健康系统** | 健康值/疲惫值/饥饿值，随机患病（感冒/抑郁/焦虑），饥饿归零会持续扣血，积极情绪促进康复 |
| **生理节律** | 22点后自然入睡，1-8小时随机时长，睡眠中不响应消息 |
| **梦境系统** | 睡眠中40%概率触发梦境，由小模型实时生成，醒来时自动注入上下文(记忆) |
| **日记系统** | 空闲时自动撰写有文采的日记，可命令查看（支持分页/日期筛选） |
| **新闻系统** | 定期从RSS获取热点，自主决定是否与你分享讨论 |
| **好感度** | 0-100量化亲密度，影响主动联系频率和话题深度，自然衰减 |
| **虚拟货币（元）** | 用户每日系统发放，可赠礼/购物互动，可打工赚钱 |
| **心跳系统** | 后台轮询（默认30分钟），自主决策：联系用户/写日记/查看日记/工作/睡觉/无动作；感知用户不活跃时长 |
| **任务调度** | 用户或AI创建定时任务，到期时触发AI执行(默认30s检测一次) |
| **上下文压缩** | 对话过长时自动摘要，节省Token |
| **多信道** | CLI命令行 / 微信（扫码登录）/ 飞书 / QQ官方机器人 |
| **技能系统** | 通过 `config/skills.yaml` 定义可调用技能，AI 使用 `<SKILL name="..."/>` 激活 |
| **工具调用** | 可选的沙盒工具系统：读写文件、glob/grep 搜索、命令行、网络请求 |
---

## 🚀 快速开始

### 环境要求

- Node.js >= 20（微信信道建议 >= 22）
- npm >= 9

### 安装 or 构建

```bash
git clone https://github.com/teuioen/cyberfriend.git
cd cyberfriend
npm install
# OR
npm run build
```

### 配置

**第一步：从模板复制配置文件**

```bash
npm start -- -onboard # 快速配置

# OR

cp config/app.yaml.example config/app.yaml
cp config/character.yaml.example config/character.yaml
```

**第二步：编辑 `config/app.yaml`，填写 API 信息**

```yaml
api:
  baseUrl: "https://your-openai-compatible-endpoint/v1"
  apiKey: "sk-xxxxxxxx"
  model: "your-default-model"   # 全局默认模型，main/mini/vision 未单独指定时继承此设置

  main:          # 主模型（对话、决策）
    model: "your-main-model-name"      # 可选，覆盖全局 model
  mini:          # 小模型（摘要、压缩、梦境）—— 未配置则继承全局设置
    model: "your-mini-model-name"
  vision:        # 视觉模型（图片理解）—— 未配置则继承全局设置
    model: "your-vision-model-name"
```

> 支持为每个模型单独配置不同的 `baseUrl` 和 `apiKey`，适合混用本地+云端模型。如果三个模型用同一个，只需填写全局 `model` 字段即可。

**第三步：自定义 `config/character.yaml`（可选）**

修改角色的姓名、性格、背景故事和说话风格，打造你专属AI。

商店商品列表在 `config/shop.yaml`（默认100+种商品，可自行添加）。

### 运行

```bash
# 生产模式
npm start

# 开发模式（ts-node）
npm run dev

# 命令行参数（优先级高于配置文件）
npm start -- --config ./my-config.yaml   # 指定配置文件路径
npm start -- --data-dir ./my-data        # 指定数据目录（覆盖所有数据路径：数据库、日志、微信Session等）
npm start -- --debug                     # 开启调试模式
npm start -- --channel cli,wechat        # 覆盖启用的信道列表
npm start -- --active-channel cli        # 启动时强制激活指定信道（CLI专用）
npm start -- --log-requests              # 打印完整请求体（调试API用）
npm start -- --dry-run                   # 打印请求体和Token估算，不实际发送请求
npm start -- --onboard                   # 运行首次配置向导（交互式生成 app.yaml）

# 组合示例
npm start -- --data-dir /tmp/cyberfriend-test --debug --log-requests
```

---

## 🐳 Docker 部署

### 使用 Docker Compose（推荐）

最简单的部署方式，适合本地开发和服务器部署。

**第一步：准备配置文件**

```bash
mkdir -p config data logs
cp config/app.yaml.example config/app.yaml
cp config/character.yaml.example config/character.yaml
```

编辑 `config/app.yaml`，填写 API 密钥和角色配置。

**第二步：启动容器**

```bash
# 后台启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 交互式启动（直接输入命令）
docker-compose up

# 停止容器
docker-compose down
```

容器会：
- 挂载 `./data` 为持久化数据目录（数据库、微信 Session 等）
- 挂载 `./logs` 为日志目录
- 挂载 `./config` 为配置目录
- 自动重启（除非手动停止）

### 使用 Docker CLI

如果只有单容器，或者不想用 docker-compose：

```bash
# 构建镜像
docker build -t cyberfriend:latest .

# 运行容器（数据持久化到 /data 目录）
docker run -it \
  --name cyberfriend \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  --restart unless-stopped \
  cyberfriend:latest

# 后台运行
docker run -d \
  --name cyberfriend \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  --restart unless-stopped \
  cyberfriend:latest

# 查看运行日志
docker logs -f cyberfriend

# 进入容器交互
docker exec -it cyberfriend sh
```

### 环境变量

容器支持以下环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATA_DIR` | 数据目录路径 | `/app/data` |
| `NODE_ENV` | 运行环境 | `production` |
| `TZ` | 时区 | `Asia/Shanghai` |

### 多主机部署（群晖、NAS 等）

群晖 Docker 容器的运行示例：

1. 在 Registry 中搜索并下载最新的 `cyberfriend` 镜像（或上传本地构建的镜像）
2. 创建容器：
   - 容器名称：`cyberfriend`
   - 镜像：`cyberfriend:latest`
   - 高级设置 → 启用自动重启
3. 卷挂载：
   - `/app/data` → `/docker/cyberfriend/data`
   - `/app/config` → `/docker/cyberfriend/config`
4. 环境变量：
   - `NODE_ENV=production`
   - `TZ=Asia/Shanghai`

---

## 💬 CLI 命令速查

启动后进入交互界面，直接输入文字与 Ta 对话。

**键盘快捷键**：
- **按两次 ESC（0.5秒内）** - 中止正在进行的 AI 请求

**界面说明**：
- 用户输入提示符为绿色 `>`，AI 回复前缀为青色角色名
- CLI 镜像：非 CLI 信道的消息将在 CLI 上镜像显示，系统会定期显示时间分割线（示例：`━━ 2026-04-17 21:07:05 ━━`）

### 查看类

| 命令 | 说明 |
|------|------|
| `/status` | 查看情绪、健康、好感度、货币等完整状态 |
| `/stats` | 查看关系统计数据（对话次数、在线时间等） |
| `/view_diary` | 查看日记（`/view_diary 2` 翻页，`/view_diary u/d` 上下翻页，`/view_diary 2026-01-01` 按日期，`/view_diary s 关键词` 搜索） |
| `/memories` | 查看最近记忆（`/memories all` 全部，`/memories <N>` 第N页，`/memories search 关键词` 搜索） |
| `/dreams` | 查看梦境记录 |
| `/news` | 查看最近新闻（格式：`[来源] 标题`，✓ 表示已被Ta分享过） |
| `/news_detail <序号>` | 查看指定新闻的详细摘要（如：`/news_detail 0`） |
| `/tasks` | 查看待执行定时任务 |
| `/inventory` | 查看 Ta 的背包 |
| `/my_inventory` | 查看自己的背包和余额 |
| `/weather` | 查看当前天气 |

### 互动类

| 命令 | 说明 |
|------|------|
| `/give <物品> [数量]` | 赠送物品给 Ta |
| `/give money <金额>` | 转账元给 Ta |
| `/shop [关键词]` | 查看或搜索商店商品 |
| `/buy <物品> [数量]` | 自己购买物品（存入自己背包） |
| `/use <物品>` | 使用自己背包中的物品 |
| `/useitem <物品>` | 让 Ta 使用其背包中的物品 |
| `/remind <时间> <内容>` | 创建定时提醒（如：`/remind 2026-06-01 18:00 去看烟花`） |

### 系统控制类

| 命令 | 说明 |
|------|------|
| `/channel [name]` | 查看或切换当前活跃信道（用于多信道模式，如 `/channel wechat` 切到微信） |
| `/preferred-channel [name]` | 设置优先发送信道；AI 回复与主动消息都会优先发到该信道（`/preferred-channel clear` 清除） |
| `/wake [消息]` | 强制唤醒 Ta（可附带消息，如 `/wake 起床了！`） |
| `/sleep` | 让 Ta 立刻去睡觉 |
| `/work [小时]` | 让 Ta 去打工赚钱（打工期间不参与对话） |
| `/work quit` | 结束打工（无工资） |
| `/block` | 屏蔽 Ta 的主动消息 |
| `/unblock` | 解除屏蔽，或申请解除拉黑 |
| `/heartbeat` | 立刻触发一次心跳 |
| `/context` | 查看当前 Token 用量（使用 gpt-tokenizer 精确计算，中文误差 <5%） |
| `/context prompt` | 查看当前系统提示词 |
| `/context history` | 查看对话历史摘要 |
| `/context clear` | 清空对话历史（不可恢复） |
| `/clear` | 清空终端屏幕 |
| `/compress` | 手动触发上下文压缩（生成摘要） |
| `/help` | 显示帮助 |
| `/quit` | 退出程序 |

### 🐛 调试命令（需在 `app.yaml` 中设 `debug: true`）

| 命令 | 说明 |
|------|------|
| `/debug unblock` | 强制解除所有拉黑/屏蔽 |
| `/debug sleep [小时]` | 强制进入睡眠（如：`/debug sleep 8`） |
| `/debug sleep_dream [小时]` | 强制进入睡眠并立即触发梦境生成 |
| `/debug wake` | 强制唤醒（只重置状态，不触发起床AI流程） |
| `/debug wake_natural` | 强制自然醒（触发完整起床AI流程，会看到未读消息） |
| `/debug work_stop` | 强制让 Ta 下班（只重置状态） |
| `/debug work_finish` | 强制完成打工（触发完整回来AI流程，会看到打工期间的消息） |
| `/debug tick` | 立即触发一次心跳 |
| `/debug naked <消息>` | 忽略所有上下文/记忆，仅带行动标签文档直接调用模型（测试原始输出） |
| `/debug emotion [key=val]` | 查看/设置情绪值（如：`/debug emotion joy=80`） |
| `/debug health [health=N fatigue=N]` | 查看/设置健康/疲惫值 |
| `/debug favor [数值]` | 查看/设置好感度 |
| `/debug currency [user\|ai] <金额>` | 增加元（单次上限500） |
| `/debug news` | 强制刷新并查看新闻（含已分享状态） |
| `/debug weather` | 查看天气缓存 |
| `/debug reset_chat` | 重置聊天数据（保留永久记忆） |

---

## 📱 多信道配置

在 `config/app.yaml` 的 `channels.enabled` 中声明要启用的信道：

```yaml
channels:
  enabled:
    - cli        # 命令行终端
    - wechat     # 微信
    # - feishu   # 飞书
    # - qq       # QQ 官方机器人
```

> 多信道同时启用时，来自各信道的消息互相独立，不会交叉显示到 CLI。

### 微信

```yaml
channels:
  wechat:
    targetUserId: ""                     # 留空=绑定首个发消息的用户
    storageDir: "./data/wechat-session"  # 登录凭证保存目录
    logLevel: "warn"
```

启动后扫描终端二维码登录，凭证自动保存，重启无需重新扫码。

> 使用的官方API接口，避免了封号风险。

### 飞书

```yaml
channels:
  feishu:
    appId: "cli_xxxxxxxxxxxxxxxx"     # 飞书开发者后台获取
    appSecret: "xxxxxxxxxxxxxxxx"
    targetUserId: ""                   # 留空=绑定首个发消息的用户
```

### QQ 官方机器人

```yaml
channels:
  qq:
    appId: "xxxxxxxx"
    appSecret: "xxxxxxxxxxxxxxx"
    # 目标用户 openid（空=自动绑定首条私信/C2C消息的发送者）
    targetOpenId: ""
    # 是否使用沙箱环境
    sandbox: true
```

---

## ⚙️ 关键配置项

所有配置均在 `config/app.yaml`，无需修改代码。

与角色相关的初始状态也可在 `config/character.yaml` 中通过 `initialState` 覆盖。

**配置继承规则**：
- **模型未配置某字段** → 继承全局配置
- **模型显式设置为 null** → 覆盖全局配置，不使用该参数
- **模型显式设置值** → 使用模型级配置

例如，若模型不支持 `chatTemplateKwargs` 参数，可在该模型配置中添加 `chatTemplateKwargs: null` 来覆盖全局设置。

模型池（Model Pool）与实例配置说明：
- 在单个端点（例如 api.main）下可以直接配置 model 或使用 pool 定义多个候选实例（candidates），用于降级、回退或负载切换。每个候选项可单独配置 model/baseUrl/apiKey/chatTemplateKwargs 等字段。

示例：
```yaml
api:
  main:
    pool:
      strategy: fallback   # 策略：fallback（按顺序回退）、random（随机权重选择）
      candidates:
        - model: "xxx"
          baseUrl: "https://xxx.com/v1"
        - model: "xxx/xxx"
          chatTemplateKwargs: null   # 显式设为 null 用以屏蔽全局 chatTemplateKwargs
```

优先级与继承规则（扩展说明）：
1. 候选项（candidate）中**显式设置**的字段（包括 null）优先；
2. 若候选项未设置该字段，则回退到该实例（如 api.main）的配置；
3. 如果实例级也未配置，则继承全局配置；
4. 显式设为 null 表示“覆盖并禁用”该全局参数；设置为空对象 {} 则通常表示有该字段但无键值（在请求时可能不会发送）。

说明：
- 疲惫较高时，Ta 会在心跳决策里优先考虑睡觉；
- 如果已经到达强制阈值，系统会直接安排睡眠；

---

## 📝 注意事项

- **健康值归零**时系统停止响应（角色"死亡"），可通过 `/debug health 100` 恢复
- API 费用由心跳频率和对话量决定；调大 `heartbeat.intervalMinutes` 可显著降低费用
- 数据库文件 `data/cyberfriend.db` 包含所有记忆和状态，请定期备份
- 初次运行会自动创建 `data/`
- `config/app.yaml` 含 API Key，请勿提交到公开仓库（已在 `.gitignore` 中排除）

---

## 🛠️ 开发

```bash
npm run build   # TypeScript 编译
npm run dev     # 开发模式（ts-node）
npm run clean   # 清除编译产物
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

- **Bug 反馈**：请在 [Issues](https://github.com/teuioen/cyberfriend/issues) 页面提交，尽量附上日志和复现步骤
- **功能建议**：同样在 Issues 中提出，标记 `enhancement` 标签
- **代码贡献**：Fork → 修改 → PR，代码风格遵循现有 TypeScript/ESLint 规范

项目地址：[github.com/teuioen/cyberfriend](https://github.com/teuioen/cyberfriend)

---

## 📄 许可证

本项目基于 [MIT License](./LICENSE) 开源。

Copyright (c) 2026 [teuioen](https://github.com/teuioen/)

---

*Ta 会记住你们之间发生的每一件事。*
