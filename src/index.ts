/**
 * CyberFriend 赛博朋友 主入口
 * 初始化所有系统模块，启动心跳和配置的信道
 */
import * as path from 'path';
import { runOnboard } from './onboard';
import { loadConfig } from './config/loader';
import { Database } from './database/db';
import { EmotionSystem } from './systems/emotion';
import { MemorySystem } from './systems/memory';
import { HealthSystem } from './systems/health';
import { RelationshipSystem } from './systems/relationship';
import { DiarySystem } from './systems/diary';
import { SleepSystem } from './systems/sleep';
import { WorkSystem } from './systems/work';
import { UserWorkSystem } from './systems/userWork';
import { WeatherSystem } from './systems/weather';
import { NewsSystem } from './systems/news';
import { TaskScheduler } from './systems/scheduler';
import { AIClient } from './core/ai';
import { ActionParser } from './core/actionParser';
import { ActionExecutor } from './core/actionExecutor';
import { ContextManager } from './core/context';
import { PromptBuilder } from './core/promptBuilder';
import { HeartbeatManager } from './core/heartbeat';
import { CLIChannel } from './channels/cli';
import { WechatChannel } from './channels/wechat';
import { FeishuChannel } from './channels/feishu';
import { QQChannel } from './channels/qq';
import { IChannel, sleep } from './channels/base';
import { ShopSystem } from './systems/shop';
import { SkillsSystem } from './systems/skills';
import { ToolEngine } from './core/tools';
import { ToolChatMessage } from './core/ai';
import { logger } from './utils/logger';
import { formatCurrentTime, getTodayStr } from './utils/time';
import { countTextTokens, countMessagesTokens } from './utils/tokens';
import { bold, cyan, green, yellow, red, dim, magenta, white, header, kv, valueColor, titleBar, divider } from './utils/cliFormat';
import { commandRegistry, registerCommands, registerExtraCommands, CommandResult } from './commands';

async function main() {
  // ===== 解析 CLI 参数 =====
  const argv = process.argv.slice(2);
  let configDir = path.join(process.cwd(), 'config');
  let debugOverride: boolean | undefined;
  let channelOverride: string[] | undefined;
  let logRequests = false;
  let dryRun = false;
  let dataDirOverride: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--config' || argv[i] === '-c') && argv[i + 1]) {
      configDir = path.resolve(argv[++i]);
    } else if (argv[i] === '--debug') {
      debugOverride = true;
    } else if (argv[i] === '--no-debug') {
      debugOverride = false;
    } else if ((argv[i] === '--channel' || argv[i] === '--channels') && argv[i + 1]) {
      channelOverride = argv[++i].split(',').map(s => s.trim());
    } else if (argv[i] === '--log-level' && argv[i + 1]) {
      // handled after loadConfig below
    } else if (argv[i] === '--log-requests') {
      logRequests = true;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if ((argv[i] === '--data-dir' || argv[i] === '-d') && argv[i + 1]) {
      dataDirOverride = path.resolve(argv[++i]);
    } else if (argv[i] === '--onboard') {
      await runOnboard(configDir);
      process.exit(0);
    }
  }

  // ===== 加载配置 =====
  const config = loadConfig(configDir);
  const { app, character } = config;

  // CLI 参数覆盖配置文件
  if (debugOverride !== undefined) app.debug = debugOverride;
  if (channelOverride) app.channels.enabled = channelOverride;
  // --data-dir 覆盖：将所有数据路径重定向到指定目录
  if (dataDirOverride) {
    app.database.path = path.join(dataDirOverride, 'cyberfriend.db');
    if (app.channels.wechat) {
      app.channels.wechat.storageDir = path.join(dataDirOverride, 'wechat-session');
    }
    if (app.log.logDir) {
      app.log.logDir = path.join(dataDirOverride, 'logs');
    }
  }

  logger.setLevel(app.log.level);
  if (app.log.logDir) {
    const logPath = path.isAbsolute(app.log.logDir) ? app.log.logDir : path.join(process.cwd(), app.log.logDir);
    logger.initFileLog(logPath, app.log.retentionDays ?? 30);
  }
  logger.info(`CyberFriend 启动中... 角色: ${character.name}`);

  // ===== 初始化数据库 =====
  const dbPath = path.isAbsolute(app.database.path) ? app.database.path : path.join(process.cwd(), app.database.path);
  const db = new Database(dbPath, {
    initialAffection: app.relationship.initialAffection,
    healthDefaults: app.health.initialValues,
    emotionDefaults: app.emotion.initialValues,
  });

  // ===== 初始化各系统 =====
  const emotionSys = new EmotionSystem(db, app.emotion);
  const memorySys = new MemorySystem(db, app.memory);
  const healthSys = new HealthSystem(db, app.health);
  const relSys = new RelationshipSystem(db, app.relationship, app.economy);
  const diarySys = new DiarySystem(db);
  const sleepSys = new SleepSystem(db, app.sleep, app.health);
  const workSys = new WorkSystem(db, relSys, healthSys, app.work ?? { earningPerHour: 50, maxHours: 72, fatiguePerHour: 8 });
  const userWorkSys = new UserWorkSystem(db, relSys, app.work ?? { earningPerHour: 50, maxHours: 72 });
  const newsSys = new NewsSystem(db, app.news);
  const scheduler = new TaskScheduler(db);
  const shopSys = new ShopSystem(
    db, relSys, healthSys,
    path.join(process.cwd(), 'config', app.shopConfigPath ?? 'shop.yaml')
  );
  const weatherSys = new WeatherSystem(db, app.weather ?? { enabled: false, city: 'Shanghai', fetchIntervalMinutes: 60 });

  // ===== 工具系统 & 技能系统 =====
  let toolEngine: ToolEngine | undefined;
  if (app.tools) {
    toolEngine = new ToolEngine(app.tools);
    const workspaceDisplay = app.tools.workspace ?? 'data/workspace';
    logger.info(`[Tools] 工具系统已初始化，工作区: ${workspaceDisplay}，配置启用: ${app.tools.enabled}`);
  }
  const skillsSys = app.skills ? new SkillsSystem(app.skills) : undefined;

  // ===== 初始化AI和核心模块 =====
  const ai = new AIClient(app.api, (usage) => {
    db.recordApiUsage({
      endpoint: usage.endpoint,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      createdAt: Date.now()
    });
  }, logRequests);
  ai.charName = character.name;  // 角色真实姓名
  const contextMgr = new ContextManager(db, ai, app.context);
  const promptBuilder = new PromptBuilder(
    character, emotionSys, healthSys, memorySys, relSys, diarySys, scheduler, workSys, weatherSys,
    shopSys, toolEngine, skillsSys
  );
  const actionExecutor = new ActionExecutor(
    emotionSys, healthSys, memorySys, relSys, diarySys, sleepSys, scheduler, ai, character, shopSys, workSys, db, weatherSys,
    toolEngine, skillsSys
  );
  // 启用行动摘要输出（如果配置指定）
  actionExecutor.setShowActionSummary(app.showActionSummary ?? false);

  function ensurePermanentMemoriesInitialized(): void {
    const permMems = memorySys.getPermanentMemories();
    if (permMems.length > 0) return;

    const identityText = `我叫${character.name}，${formatGender(character.gender)}，${character.age}岁，${character.profession}`;
    memorySys.save('permanent', identityText, 10);
    memorySys.save('permanent', `我的兴趣爱好：${character.interests.join('、')}`, 8);
    if (character.background?.trim()) {
      memorySys.save('permanent', `我的背景：${character.background.trim()}`, 9);
    }
    logger.info('[System] 已初始化基础永久记忆');
  }

  ensurePermanentMemoriesInitialized();

  // ===== --dry-run：打印请求体和 token 估算，不发送请求 =====
  if (dryRun) {
    console.log('\n==============================');
    console.log('  --dry-run 模式（不发送请求）');
    console.log('==============================\n');

    const systemPrompt = promptBuilder.buildChatPrompt('（示例用户消息）');
    const history = await contextMgr.getHistory();
    const summary = contextMgr.getLatestSummary();

    // 组装发给 AI 的消息数组（与真实聊天完全一致）
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: '（示例用户消息）' },
    ];

    // Token 估算
    const promptTokens = countTextTokens(systemPrompt);
    const summaryTokens = summary ? countTextTokens(summary) : 0;
    const historyTokens = countMessagesTokens(history);
    const userMsgTokens = countTextTokens('（示例用户消息）') + 4;
    const totalTokens = promptTokens + summaryTokens + historyTokens + userMsgTokens;

    console.log('--- Token 估算 ---');
    console.log(`System Prompt  : ~${promptTokens} tokens`);
    if (summary) console.log(`  其中摘要    : ~${summaryTokens} tokens`);
    console.log(`历史记录 (${history.length}条): ~${historyTokens} tokens`);
    console.log(`示例用户消息   : ~${userMsgTokens} tokens`);
    console.log(`合计（输入）   : ~${totalTokens} tokens`);
    console.log();

    const memPerm = memorySys.getPermanentMemories();
    const memLong = db.getMemories('long');
    const memShort = db.getMemories('short');
    console.log('--- 记忆 ---');
    const printMems = (mems: any[], label: string) => {
      console.log(`[${label}] ${mems.length} 条:`);
      if (!mems.length) { console.log('  （空）'); return; }
      mems.forEach(m => console.log(`  #${m.id} [重要度:${m.importance}] ${m.content}`));
    };
    printMems(memPerm, '永久');
    printMems(memLong, '长期');
    printMems(memShort, '短期');
    console.log();

    console.log('--- 完整请求体 (JSON) ---');
    const requestBody = {
      model: app.api.main.model ?? app.api.model ?? '(global default)',
      messages,
      max_tokens: app.api.chatMaxTokens ?? 600,
      temperature: app.api.temperature,
    };
    console.log(JSON.stringify(requestBody, null, 2));

    process.exit(0);
  }

  // ===== 初始化信道 =====
  const enabledChannels: string[] = (app.channels?.enabled) ?? ['cli'];

  // 收集所有活跃信道（用于广播）
  const channels: IChannel[] = [];

  // CLI 信道（仅在启用时创建）
  let cli: CLIChannel | null = null;
  if (enabledChannels.includes('cli')) {
    cli = new CLIChannel();
    cli.setCharacterName(character.name);
    channels.push(cli);
    // 注册 readline 安全打印回调，避免行动摘要粘连在输入提示符上
    ActionExecutor.setSafePrint((msg) => cli!.writeLine(msg));
    // debug 模式下将压缩通知显示在 CLI
    if (app.debug) {
      contextMgr.onCompressNotify = (msg) => {
        cli!.sendNotice(msg).catch(() => { });
      };
    }
  }

  // 微信信道（可选）
  let wechatChannel: WechatChannel | null = null;
  if (enabledChannels.includes('wechat') && app.channels?.wechat) {
    wechatChannel = new WechatChannel(app.channels.wechat);
    channels.push(wechatChannel);
  }

  // 飞书信道（可选）
  if (enabledChannels.includes('feishu') && app.channels?.feishu) {
    const feishu = new FeishuChannel(app.channels.feishu);
    channels.push(feishu);
  }

  // QQ 官方机器人信道（可选）
  if (enabledChannels.includes('qq') && app.channels?.qq) {
    const qq = new QQChannel(app.channels.qq);
    channels.push(qq);
  }

  // 每日数据初始化（新用户或新的一天）
  const lastDay = db.getSetting('last_active_day');
  const today = getTodayStr();
  if (lastDay !== today) {
    relSys.dailyGrant();
    db.setSetting('last_active_day', today);
    logger.info(`[System] 新的一天: ${today}，已发放每日货币`);
  }

  // ===== 最近活跃信道追踪 =====
  // 用于定时器/心跳主动消息：只发到用户最后使用的信道，不广播
  let lastActiveChannel: IChannel | null = null;

  // ===== 优先发送信道 =====
  // 用户可以设置一个"默认信道"，系统将优先发送到该信道（即使未激活）
  let preferredChannelName: string | null = null;

  // ===== 消息发送函数 =====
  // AI 主动消息首先尝试发送到优先信道，其次是最近活跃信道；CLI 作为日志镜像始终接收（受 systemNoticeInCli 控制）
  async function sendToUser(messages: string[]): Promise<void> {
    if (db.getBlacklist().blacklistedByUser) return;

    // 优先信道查找：首先查找 preferredChannelName，其次是 lastActiveChannel
    let target: IChannel | null = null;
    if (preferredChannelName) {
      target = channels.find(ch => ch.name.toLowerCase() === preferredChannelName!.toLowerCase()) ?? null;
    }
    if (!target) {
      target = lastActiveChannel ?? (channels[0] ?? null);
    }

    const showInCli = app.heartbeat.systemNoticeInCli ?? true;
    if (target) {
      await target.sendMessages(messages, app.message.minDelayMs, app.message.maxDelayMs, app.message.typingSpeedCharsPerSec);
      // 若活跃信道不是 CLI，CLI 仍作为日志镜像同步显示
      if (showInCli && cli && target !== cli) {
        await cli.sendMessages(messages, app.message.minDelayMs, app.message.maxDelayMs, app.message.typingSpeedCharsPerSec);
      }
    } else {
      await Promise.all(channels.map(ch => ch.sendMessages(messages, app.message.minDelayMs, app.message.maxDelayMs, app.message.typingSpeedCharsPerSec)));
    }
  }

  // ===== 心跳管理器 =====
  // debug模式下只向CLI信道发送标签调试信息
  const heartbeatDebugNotify = (app.debug && cli)
    ? async (msg: string) => { await cli!.sendNotice(msg); }
    : undefined;

  // 系统通知函数：默认仅 CLI 显示；开启 systemNoticeToAllChannels 后广播所有信道
  const sendSystemNotice: (msgs: string[]) => Promise<void> = async (msgs) => {
    const toAll = app.heartbeat.systemNoticeToAllChannels ?? false;
    const showInCli = app.heartbeat.systemNoticeInCli ?? true;
    if (toAll) {
      for (const msg of msgs) {
        await Promise.all(channels.map(ch => ch.sendNotice(msg)));
      }
    } else if (showInCli && cli) {
      for (const msg of msgs) {
        await cli.sendNotice(msg);
      }
    }
  };

  // ===== 中断机制（按两次 ESC 中止 AI 请求）=====
  let currentAIAbortController: AbortController | null = null;
  if (cli) {
    cli.setRequestAbortHandler(() => {
      // 仅当有真实的 AI 请求在进行时才中止，返回是否真的中止了
      if (currentAIAbortController) {
        currentAIAbortController.abort();
        cli.stopProcessing();  // 清除"正在输入中"的 UI
        return true;  // 表示真的中止了请求
      }
      return false;  // 没有正在进行的请求
    });
  }

  const heartbeat = new HeartbeatManager(
    ai, actionExecutor, promptBuilder, contextMgr,
    emotionSys, healthSys, memorySys, relSys,
    sleepSys, newsSys, scheduler, diarySys,
    app.heartbeat, sendToUser, app.news, workSys, heartbeatDebugNotify, sendSystemNotice
  );

  // ===== 打工结束检查（每分钟检查一次）=====
  setInterval(async () => {
    // 用户打工结束检查
    try {
      const result = userWorkSys.checkWorkEnd();
      if (result) {
        const msg = `你打工结束啦！辛苦了，获得 ${result.earned} 虚拟币（工作了 ${result.hours.toFixed(1)} 小时）`;
        await sendSystemNotice([msg]);
      }
    } catch (e) {
      logger.debug(`[UserWork] 检查失败: ${e}`);
    }

    // AI打工结束检查（心跳间隔长，独立检查避免通知延迟）
    try {
      const aiResult = workSys.checkWorkEnd();
      if (aiResult) {
        memorySys.save('short', `打工结束，赚了 ${aiResult.earned} 虚拟币`, 4);
        await sendSystemNotice([`打工回来了！这次干了 ${aiResult.hours}h，赚到了 ${aiResult.earned} 虚拟币 💰`]);
      }
    } catch (e) {
      logger.debug(`[Work] AI打工检查失败: ${e}`);
    }

    // 定期刷新天气（懒加载，不阻塞）
    weatherSys.fetchWeather().catch(() => { });
  }, 60 * 1000);

  // 启动时拉取一次天气
  weatherSys.fetchWeather().catch(() => { });

  // ===== 命令注册（全信道共享）=====
  function addCommand(name: string, handler: (args: string[]) => Promise<string | CommandResult | void>): void {
    commandRegistry.set(name.toLowerCase(), handler);
    if (cli) cli.registerCommand(name, handler as (args: string[]) => Promise<string | void>);
  }
  registerCommands(addCommand, {
    db, emotionSys, healthSys, memorySys, relSys,
    diarySys, sleepSys, newsSys, scheduler, heartbeat, shopSys, character,
    promptBuilder, contextMgr, userWorkSys, workSys, weatherSys, ai,
    debugMode: !!app.debug
  });

  registerExtraCommands(addCommand, {
    db, emotionSys, healthSys, memorySys, relSys,
    diarySys, sleepSys, newsSys, scheduler, heartbeat, shopSys, character,
    promptBuilder, contextMgr, userWorkSys, workSys, weatherSys, ai,
    debugMode: !!app.debug },
    channels,
    () => lastActiveChannel ?? undefined,
    (ch) => { lastActiveChannel = ch; },
    () => preferredChannelName,
    (name) => { preferredChannelName = name; }
  );

  /**
   * 格式化已解析的行动标签列表用于调试显示（委托给 ActionParser）
   */
  function formatActionsForDebug(actions: import('./core/actionParser').ParsedAction[]): string {
    return ActionParser.formatForDebug(actions);
  }

  /**
   * 格式化已解析的行动标签列表用于日志文件显示
   */
  function formatActionsForDebugLog(actions: import('./core/actionParser').ParsedAction[]): string {
    return ActionParser.formatForDebugLog(actions);
  }

  /** 构建消息并调用 AI，将响应发送至指定信道 */
  async function callAI(userMessage: string, sourceChannel: IChannel, imageUrl?: string): Promise<void> {
    if (cli) cli.startWaiting();  // 无论哪个信道触发，CLI 均显示等待指示器
    // 通知心跳：callAI 正在运行，心跳跳过本轮，避免双重输出
    heartbeat?.setExternalAIBusy(true);
    // 创建中止控制器
    currentAIAbortController = new AbortController();
    const abort = currentAIAbortController;
          
    try {
      const systemPrompt = promptBuilder.buildChatPrompt(userMessage);
      const history = await contextMgr.getHistory();
      const summary = contextMgr.getLatestSummary();
      const fullSystemPrompt = summary
        ? `${systemPrompt}\n\n[对话历史摘要]\n${summary}`
        : systemPrompt;
      const ctxMsg = promptBuilder.buildContextMessage(userMessage);
      let msgs: any[] = [
        { role: 'system' as const, content: fullSystemPrompt },
        { role: 'assistant' as const, content: ctxMsg },
        ...history
      ];

      // 多模态：将最后一条 user 消息改为图文格式
      if (imageUrl) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user') {
            msgs[i] = {
              role: 'user',
              content: [
                { type: 'text', text: msgs[i].content },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            };
            break;
          }
        }
      }

      // 检查是否已被中止
      if (abort.signal.aborted) {
        if (cli) cli.stopProcessing();
        contextMgr.removeLastUserMessage();
        return;
      }

      // ── 工具调用路径（native function calling）──
      let response: string;

      if (toolEngine?.isEnabled()) {
        const openAITools = toolEngine.getOpenAITools();
        const initialMsgsCount = msgs.length;  // 记录初始消息数，用于切片出中间交换
        let toolMsgs: ToolChatMessage[] = msgs as ToolChatMessage[];
        let toolRound = 0;
        const MAX_TOOL_ROUNDS = 30;
        let lastContent = '';

        while (true) {
          toolRound++;
          if (toolRound > MAX_TOOL_ROUNDS) {
            logger.warn('[Tools] 工具调用轮次超限，强制退出');
            break;
          }
          if (cli) cli.startWaiting();
          const toolsResult = await ai.chatWithTools(toolMsgs, openAITools, 0.7, abort.signal, app.tools?.callbackMaxOutputTokens);
          if (cli) cli.stopProcessing();

          if (app.debug && cli && ai.lastUsedModel) {
            await cli.sendNotice(`\x1b[2m[DEBUG] [工具 #${toolRound}] ${ai.lastUsedModel}${toolsResult.toolCalls.length ? ` (${toolsResult.toolCalls.length}个调用)` : ''}\x1b[0m`);
          }

          lastContent = toolsResult.content;

          if (toolsResult.toolCalls.length === 0 || abort.signal.aborted) break;

          // 追加 assistant 消息（含 tool_calls）
          toolMsgs = [...toolMsgs, {
            role: 'assistant' as const,
            content: toolsResult.content || null,
            tool_calls: toolsResult.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }];

          // 执行每个工具调用，追加 tool 结果消息
          for (const tc of toolsResult.toolCalls) {
            const toolResult = await toolEngine.call(tc.name, tc.arguments);
            const output = toolResult.error ? `[错误] ${toolResult.error}` : toolResult.output;

            if (toolResult.error) {
              ActionExecutor.printSafe(`\x1b[31m⚠ [工具错误] ${tc.name}: ${toolResult.error}\x1b[0m`);
            }

            if (tc.name === 'shell' && output) {
              const allLines = output.split('\n');
              const MAX_LINES = 15;
              const lines = allLines.length > MAX_LINES
                ? [`\x1b[2m...(${allLines.length - MAX_LINES}行已省略)\x1b[0m`, ...allLines.slice(-MAX_LINES)]
                : allLines;
              const DIM = '\x1b[2m', RESET = '\x1b[0m';
              const block = lines.map(l => `  ${DIM}│${RESET} ${l}`).join('\n');
              ActionExecutor.printSafe(block);
            }

            let summary: string;
            if (tc.name === 'read_file') summary = `read_file: ${tc.arguments.path ?? ''} (${output.split('\n').length}行)`;
            else if (tc.name === 'write_file') { const c = tc.arguments.content; summary = `write_file: ${tc.arguments.path ?? ''} (+${String(c ?? '').split('\n').length}行)`; }
            else if (tc.name === 'edit_file') summary = `edit_file: ${tc.arguments.path ?? ''}`;
            else if (tc.name === 'shell') { const c = tc.arguments.cmd ?? ''; summary = `shell: ${c.slice(0, 60)}${c.length > 60 ? '...' : ''}`; }
            else summary = `${tc.name}: ${toolResult.error ? '失败' : '成功'}`;
            logger.info(`[Tools] 第${toolRound}轮 ${summary}`);

            toolMsgs = [...toolMsgs, {
              role: 'tool' as const,
              content: output,
              tool_call_id: tc.id,
            }];
          }
        }

        // 保存中间工具交换到数据库，让下一轮对话能看到本轮工具调用过程
        const toolExchange = toolMsgs.slice(initialMsgsCount);
        if (toolExchange.length > 0) {
          contextMgr.addToolMessages(toolExchange);
        }

        response = lastContent;
      } else {
        // 无工具路径：普通 chat
        if (cli) cli.startWaiting();
        response = await ai.chat(msgs, 0.7, abort.signal);
        if (cli) cli.stopProcessing();
      }

      // Debug 模式：显示使用的模型
      if (app.debug && cli && ai.lastUsedModel) {
        const modelInfo = `[DEBUG] [模型] ${ai.lastUsedModel}`;
        await cli.sendNotice(`\x1b[2m${modelInfo}\x1b[0m`);
      }

      const { actions, visibleText } = ActionParser.parse(response);
      
      if (actions.length > 0) {
        if (app.debug && cli) {
          const debugOutput = `[DEBUG]: ${formatActionsForDebug(actions)}`;
          await cli.sendNotice(debugOutput);
        } else {
          logger.fileOnly(`[ACTION]\n${formatActionsForDebugLog(actions)}`);
        }
      }

      let execResult = await actionExecutor.execute(actions);

      // ── 日记/技能注入回调（非工具的二次 AI 调用）──
      const nonToolInjections: string[] = [];
      if (execResult.diaryEntries) nonToolInjections.push(`[翻阅日记]\n${execResult.diaryEntries}`);
      if (execResult.systemMessagesToInject?.length) nonToolInjections.push(...execResult.systemMessagesToInject);

      let finalResponse = response;
      let finalVisibleText = visibleText;

      if (nonToolInjections.length > 0 && !abort.signal.aborted) {
        const injectContent = '[系统反馈]\n' + nonToolInjections.join('\n\n');
        const strippedResponse = ActionParser.stripAll(response).trim() || '（已处理）';
        finalVisibleText = '';

        const roundMsgs: any[] = [
          ...msgs,
          { role: 'assistant' as const, content: strippedResponse },
          { role: 'user' as const, content: injectContent },
        ];
        logger.info(`[Main] 系统注入回调：注入 ${nonToolInjections.length} 条结果`);
        if (cli) cli.startWaiting();
        const callbackResp = await ai.chat(roundMsgs, 0.7, abort.signal, app.tools?.callbackMaxOutputTokens);
        if (cli) cli.stopProcessing();
        if (app.debug && cli && ai.lastUsedModel) {
          await cli.sendNotice(`\x1b[2m[DEBUG] [回调] ${ai.lastUsedModel}\x1b[0m`);
        }
        const { actions: actionsN, visibleText: vtN } = ActionParser.parse(callbackResp);
        if (actionsN.length > 0) {
          if (app.debug && cli) await cli.sendNotice(`[DEBUG 回调]: ${formatActionsForDebug(actionsN)}`);
          else logger.fileOnly(`[ACTION 回调]\n${formatActionsForDebugLog(actionsN)}`);
        }
        const execResultN = await actionExecutor.execute(actionsN);
        execResult = { ...execResult, ...execResultN,
          messagesToSend: execResultN.messagesToSend,
          silent: execResultN.silent,
          systemMessagesToInject: undefined,
          diaryEntries: undefined,
        };
        finalResponse = callbackResp;
        finalVisibleText = vtN;
      }

      // SILENT 标签：若同时有可见文字，仍然发送；仅在无任何文字时才完全沉默
      if (execResult.silent && !finalVisibleText && execResult.messagesToSend.length === 0) {
        logger.info('[Main] AI选择沉默，不回复本次消息');
        contextMgr.addAssistantMessage(finalResponse, '');
        return;
      }

      if (execResult.messagesToSend.length > 0) {
        const parts = execResult.messagesToSend;
        contextMgr.addAssistantMessage(finalResponse, parts.join(' | '));
        await sendWithDelay(parts, app.message, sourceChannel);
      } else if (finalVisibleText) {
        const parts = ActionParser.splitMessages(finalVisibleText);
        contextMgr.addAssistantMessage(finalResponse, finalVisibleText);
        if (parts.length > 0) await sendWithDelay(parts, app.message, sourceChannel);
      } else {
        logger.warn(`[Main] AI响应无可见文本，原始响应: ${response.slice(0, 300)}`);
      }

      // 每轮对话后对梦境记忆进行渐进式模糊
      memorySys.blurDreamsForTurn();

      if (execResult.sleepStarted) {
        const wakeDesc = sleepSys.getWakeUpDescription();
        await sleep(1000);
        // 睡觉/打工状态通知仅发 CLI，不推送到其他信道
        await (cli ?? getTargetChannel(sourceChannel)).sendNotice(`${cyan('[系统通知]')} Ta去睡觉了... ${wakeDesc}`);
      }
      if (execResult.workStarted) {
        const desc = workSys.getWorkDescription();
        await sleep(500);
        await (cli ?? getTargetChannel(sourceChannel)).sendNotice(`${cyan('[系统通知]')} Ta出去打工了。${desc} 打工期间不会回复消息`);
      }
    } catch (err: any) {
      if (abort.signal.aborted) {
        // 用户中止请求：删除已加入的用户消息，不加入上下文
        contextMgr.removeLastUserMessage();
        logger.info('[Main] 用户中止了 AI 请求');
        return;
      }
      if (cli) cli.stopProcessing();
      logger.error(`[Main] 处理消息失败: ${err?.message}`);
      const target = getTargetChannel(sourceChannel);
      await target.sendMessage('...（网络好像有点问题，等一下）');
    } finally {
      currentAIAbortController = null;
      // 解锁心跳并发锁
      heartbeat?.setExternalAIBusy(false);
    }
  }

  async function handleUserMessage(rawText: string, sourceChannel: IChannel): Promise<void> {
    let userText = rawText;
    // 记录最近活跃信道（用于心跳/定时器通知的单信道发送）
    lastActiveChannel = sourceChannel;

    // /命令 支持所有信道
    if (userText.startsWith('/')) {
      const parts = userText.slice(1).trim().split(/\s+/);
      const cmdName = (parts[0] ?? '').toLowerCase();
      const args = parts.slice(1);

      // /wake [消息] 特殊处理：唤醒后触发AI响应；附带消息则同时当作对话内容
      if (cmdName === 'wake') {
        if (!sleepSys.isAsleep()) {
          await sourceChannel.sendNotice(`${cyan('[系统通知]')} Ta没在睡觉`);
          return;
        }
        sleepSys.forceWakeUp();
        await sourceChannel.sendNotice(`${cyan('[系统通知]')} Ta被唤醒了...`);
        const wakeMsg = args.join(' ').trim();
        // 若附带消息，先保存到上下文（保证对话连续性）
        if (wakeMsg) {
          contextMgr.addUserMessage(wakeMsg);
        }
        // 触发 AI 起床响应（不阻塞，异步执行）
        heartbeat.triggerWakeResponse(wakeMsg || undefined).catch(e =>
          logger.error(`[Wake] triggerWakeResponse 错误: ${e}`)
        );
        return;  // 不再走正常消息流程，避免重复处理
      } else {
        const handler = commandRegistry.get(cmdName);
        if (handler) {
          const result = await handler(args);
          if (result && typeof result === 'object' && 'triggerEvent' in result) {
            // 命令请求触发AI即时响应
            if (result.notice) await sourceChannel.sendNotice(`${cyan('[系统通知]')} ${result.notice}`);
            if (result.triggerEvent) {
              // 注入事件到上下文，然后调用AI
              contextMgr.addUserMessage(result.triggerEvent);
              await callAI(result.triggerEvent, sourceChannel);
            }
          } else if (result) {
            await sourceChannel.sendNotice(result as string);
          }
        } else {
          await sourceChannel.sendNotice(`${cyan('[系统通知]')} 未知命令: /${cmdName}，输入 /help 查看帮助`);
        }
        return;
      }
    }

    // 检查AI是否已"死亡"（健康值归零）
    if (healthSys.isDead()) {
      await sourceChannel.sendNotice(`${cyan('[系统通知]')} Ta已经不在了...`);
      return;
    }

    // 检查是否在睡觉 — 保存消息到上下文，醒来后会读到并回复
    if (sleepSys.isAsleep()) {
      contextMgr.addUserMessage(userText);  // 排队，醒来后处理
      const wakeDesc = sleepSys.getWakeUpDescription();
      logger.info(`${cyan('[系统通知]')} Ta正在睡觉中... ${wakeDesc}`);
      return;
    }

    // 检查是否在打工（Ta手机上缴）— 保存消息到上下文，打工结束后 AI 会看到并决策回复
    if (workSys.isWorking()) {
      contextMgr.addUserMessage(userText);  // 排队，打工结束后处理
      const desc = workSys.getWorkDescription();
      logger.info(`${cyan('[系统通知]')} Ta正在打工，手机已上缴。 ${desc}`);
      return;
    }

    // 检查拉黑状态（AI拉黑用户）
    const bl = db.getBlacklist();
    if (bl.blacklistedByAi) {
      await sourceChannel.sendNotice(`${cyan('[系统通知]')} 你被拉黑了！（输入 /apply_unblock 申请解除） ${bl.reasonByAi ? ` \n 原因：${bl.reasonByAi}` : ''}`);
      return;
    }

    // 检查用户是否在打工（用户手机上缴）
    if (userWorkSys.isWorking()) {
      const desc = userWorkSys.getWorkDescription();
      await sourceChannel.sendNotice(`${cyan('[系统通知]')} 你正在打工中，没时间聊天。 ${desc}\n（输入 /work quit 跑路，但没有工资）`);
      return;
    }

    // 视觉处理：含图片时，有视觉端点则先提取描述，否则直接多模态传给主模型
    let imageUrl: string | undefined;
    // 匹配带内容的图片标签：[发了一张图片: URL] 或 [发了一张图片: data:...]
    const imgMatchUrl = userText.match(/\[发了一张图片:\s*([^\]]+)\]/);
    // 匹配不带内容的图片：[发了一张图片] 或 [图片]
    const imgMatchNoUrl = !imgMatchUrl && /\[发了一张图片\]|\[图片\]/.test(userText);

    if (imgMatchUrl) {
      const rawImgUrl = imgMatchUrl[1].trim();
      const isBase64 = rawImgUrl.startsWith('data:');
      if (app.api.vision) {
        // 有独立视觉端点：先理解图片，替换为文字描述
        try {
          logger.info(`[Vision] 正在分析图片${isBase64 ? '（base64）' : `: ${rawImgUrl.slice(0, 60)}`}`);
          const visionPrompt = '请描述这张图片的内容，如果有文字请一并识别出来，50字以内。';
          const desc = await ai.vision(visionPrompt, rawImgUrl);
          // 成功后用文字描述替换（避免 base64 写入 DB）
          userText = userText.replace(imgMatchUrl[0], `[图片内容: ${desc.trim()}]`);
          logger.info(`[Vision] 识别结果: ${desc.trim()}`);
        } catch (e) {
          logger.warn(`[Vision] 图片分析失败，降级为多模态: ${e}`);
          userText = userText.replace(imgMatchUrl[0], '[图片]');
          imageUrl = rawImgUrl;
        }
      } else {
        // 无视觉端点：直接多模态传给主模型，DB 中存 [图片] 占位符
        logger.info('[Vision] 未配置视觉端点，图片将以多模态格式传给主模型');
        userText = userText.replace(imgMatchUrl[0], '[图片]');
        imageUrl = rawImgUrl;
      }
    } else if (imgMatchNoUrl) {
      // 无 URL 的图片（如微信某些场景），直接告知主模型有图片但无法查看
      userText = userText.replace(/\[发了一张图片\]|\[图片\]/g, '[发来了一张图片，但无法获取图片内容]');
    }

    // 保存用户消息
    contextMgr.addUserMessage(userText);
    relSys.adjustAffection(0.5);

    // 非 CLI 信道来的消息：在 CLI 上镜像显示，便于监控
    if (cli && sourceChannel !== cli) {
      const ts = formatCurrentTime();
      // 镜像显示时去掉消息末尾的多余中文/英文标点与空白，避免显示额外句号
      const mirrorText = userText.replace(/[。！？…,.!?；;，、\s]+$/u, '');
      cli.writeLine(`\x1b[2m[${ts}]\x1b[0m \x1b[33m[${sourceChannel.name}]\x1b[0m \x1b[90m>\x1b[0m ${mirrorText}`);
    }

    await callAI(userText, sourceChannel, imageUrl);
  }

  // ===== 注册所有信道的消息处理器 =====
  // 注意：每个信道只处理来自自身的消息，回复也只发回该信道（不广播到其他信道）
  for (const ch of channels) {
    const channel = ch; // 捕获引用
    ch.onMessage(async (userText) => {
      await handleUserMessage(userText, channel);
    });
  }

  // ===== 启动所有信道 =====
  heartbeat.start();
  // 先立即启动 CLI（不阻塞在其他信道连接上），再并行启动其他信道
  if (cli) await cli.start();
  // 其余信道（如微信）并行后台启动，不阻塞 CLI 交互
  const otherChannels = channels.filter(ch => ch !== cli);
  if (otherChannels.length > 0) {
    Promise.all(otherChannels.map(ch => ch.start().catch(e =>
      logger.error(`[Main] 信道 ${ch.name} 启动失败: ${e?.message}`)
    )));
  }

  // 处理退出
  const shutdown = async () => {
    heartbeat.stop();
    for (const ch of channels) {
      await ch.stop().catch(() => { });
    }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  /** 根据优先信道设置，获取实际发送目标（若设置优先信道则优先，否则使用原信道） */
  function getTargetChannel(fallback: IChannel): IChannel {
    if (preferredChannelName) {
      const preferred = channels.find((ch: IChannel) => ch.name.toLowerCase() === preferredChannelName!.toLowerCase());
      if (preferred) {
        return preferred;
      }
    }
    return fallback;
  }

  /** 发送消息带延迟（适配任意信道，优先信道失败则退回到激活信道） */
  async function sendWithDelay(
    parts: string[],
    msgCfg: { minDelayMs: number; maxDelayMs: number; typingSpeedCharsPerSec: number },
    channel: IChannel
  ): Promise<void> {
    // 所有 AI 回复都优先遵循 preferred-channel；若未设置则回到原始信道
    const targetChannel = getTargetChannel(channel);
    // 去除每条消息末尾多余的句号（AI有时在"末尾不带句号"设置下仍然加句号）
    const cleanedParts = parts.map(p => p.replace(/[。.]+$/, '').trimEnd()).filter(Boolean);
    if (!cleanedParts.length) return;
    try {
      // 委托给 channel.sendMessages()，以确保 CLIChannel 的 isSendingBatch 逻辑正确工作
      await targetChannel.sendMessages(cleanedParts, msgCfg.minDelayMs, msgCfg.maxDelayMs, msgCfg.typingSpeedCharsPerSec);
      // 非 CLI 信道回复时，CLI 快速镜像显示（不带延迟，避免重复等待）
      if (cli && targetChannel !== cli) {
        const ts = formatCurrentTime();
        for (const part of cleanedParts) {
          const mirrorText = part.replace(/[。！？…,.!?；;，、\s]+$/u, '').trim();
          if (mirrorText) {
            cli.writeLine(`\x1b[2m[${ts}]\x1b[0m \x1b[33m[${targetChannel.name}]\x1b[0m \x1b[36m${character.name}\x1b[0m: ${mirrorText}`);
          }
        }
      }
    } catch (err) {
      // 如果优先信道发送失败，自动退回到原激活信道
      if (preferredChannelName && targetChannel !== channel) {
        logger.warn(`[信道] 优先信道「${targetChannel.name}」发送失败，已退回到激活信道「${channel.name}」`);
        try {
          await channel.sendMessages(parts, msgCfg.minDelayMs, msgCfg.maxDelayMs, msgCfg.typingSpeedCharsPerSec);
        } catch (fallbackErr) {
          logger.error(`[信道] 激活信道也发送失败: ${fallbackErr}`);
          throw fallbackErr;
        }
      } else {
        throw err;
      }
    }
  }

  function formatGender(raw: string): string {
    const lower = raw.trim().toLowerCase();
    if (lower === 'female' || lower === 'woman' || raw === '女' || raw === '女性') return '女性';
    if (lower === 'male' || lower === 'man' || raw === '男' || raw === '男性') return '男性';
    return raw || '未知性别';
  }
}


main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
