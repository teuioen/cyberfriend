/**
 * CyberFriend 赛博朋友 主入口
 * 初始化所有系统模块，启动心跳和配置的信道
 */
import * as path from 'path';
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
import { logger } from './utils/logger';
import { formatCurrentTime, getTodayStr } from './utils/time';
import { countTextTokens, countMessagesTokens } from './utils/tokens';
import { bold, cyan, green, yellow, red, dim, magenta, white, header, kv, valueColor, titleBar, divider } from './utils/cliFormat';

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
    path.join(process.cwd(), 'config', 'shop.yaml')
  );
  const weatherSys = new WeatherSystem(db, app.weather ?? { enabled: false, city: 'Shanghai', fetchIntervalMinutes: 60 });

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
    character, emotionSys, healthSys, memorySys, relSys, diarySys, scheduler, workSys, weatherSys
  );
  const actionExecutor = new ActionExecutor(
    emotionSys, healthSys, memorySys, relSys, diarySys, sleepSys, scheduler, ai, character, shopSys, workSys, db, weatherSys
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
    const messages: Array<{ role: string; content: string }> = [
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
        cli!.sendNotice(msg).catch(() => {});
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
    weatherSys.fetchWeather().catch(() => {});
  }, 60 * 1000);

  // 启动时拉取一次天气
  weatherSys.fetchWeather().catch(() => {});

  // ===== 命令注册（全信道共享）=====
  const commandRegistry = new Map<string, (args: string[]) => Promise<string | CommandResult | void>>();
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

  // /api <消息> — 直接调用 AI（不带上下文/记忆，用于测试）
  addCommand('api', async (args) => {
    if (!args.length) return '用法: /api <发送给AI的消息>';
    const msg = args.join(' ');
    try {
      const resp = await ai.chat([{ role: 'user', content: msg }], 0.7);
      return `[API 直接响应]\n${resp}`;
    } catch (e) {
      return `[API 错误] ${e}`;
    }
  });

  // /channel [name] — 查看或切换当前活跃信道（AI 回复目标）
  addCommand('channel', async (args) => {
    if (!args.length) {
      const activeName = lastActiveChannel?.name ?? '(未设置)';
      const channelNames = channels.map(ch => ch.name).join(', ');
      return `当前活跃信道: ${activeName}\n可用信道: ${channelNames}\n用法: /channel <信道名>`;
    }
    const target = args[0]!.toLowerCase();
    const found = channels.find(ch => ch.name.toLowerCase() === target);
    if (!found) {
      const channelNames = channels.map(ch => ch.name).join(', ');
      return `未找到信道 "${target}"，可用信道: ${channelNames}`;
    }
    lastActiveChannel = found;
    return `已切换活跃信道为: ${found.name}（后续 AI 消息将发送到此信道）`;
  });

  // /preferred-channel [name] — 设置优先信道（即使未激活，也优先发送到该信道；留空则清除）
  addCommand('preferred-channel', async (args) => {
    if (!args.length) {
      if (!preferredChannelName) {
        const channelNames = channels.map(ch => ch.name).join(', ');
        return `当前未设置优先信道\n可用信道: ${channelNames}\n用法: /preferred-channel <信道名>`;
      }
      return `当前优先信道: ${preferredChannelName}`;
    }
    const target = args[0]!.toLowerCase();
    if (target === 'clear' || target === 'none') {
      preferredChannelName = null;
      return '已清除优先信道设置';
    }
    const found = channels.find(ch => ch.name.toLowerCase() === target);
    if (!found) {
      const channelNames = channels.map(ch => ch.name).join(', ');
      return `未找到信道 "${target}"，可用信道: ${channelNames}`;
    }
    preferredChannelName = found.name;
    return `已设置优先信道为: ${found.name}（后续 AI 主动消息将优先发送到此信道，即使未激活也会发送）`;
  });

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
      let msgs: any[] = [
        { role: 'system' as const, content: fullSystemPrompt },
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

      const response = await ai.chat(msgs, 0.7, abort.signal);
      if (cli) cli.stopProcessing();

      // Debug 模式：显示使用的模型
      if (app.debug && cli && ai.lastUsedModel) {
        const modelInfo = `[DEBUG] [模型] ${ai.lastUsedModel}`;
        await cli.sendNotice(`\x1b[2m${modelInfo}\x1b[0m`);  // 灰暗显示
      }

      const { actions, visibleText } = ActionParser.parse(response);

      if (actions.length > 0) {
        if (app.debug && cli) {
          // debug模式：行动标签显示在CLI（原始文本，青色）
          const debugOutput = `[DEBUG]: ${formatActionsForDebug(actions)}`;
          await cli.sendNotice(debugOutput);
        } else {
          // 非debug模式：原始标签+中文名仅写入日志文件
          logger.fileOnly(`[ACTION]\n${formatActionsForDebugLog(actions)}`);
        }
      }

      const execResult = await actionExecutor.execute(actions);

      // SILENT 标签：若同时有可见文字，仍然发送；仅在无任何文字时才完全沉默
      if (execResult.silent && !visibleText && execResult.messagesToSend.length === 0) {
        logger.info('[Main] AI选择沉默，不回复本次消息');
        contextMgr.addAssistantMessage(response, '');
        return;
      }

      if (execResult.messagesToSend.length > 0) {
        const parts = execResult.messagesToSend;
        contextMgr.addAssistantMessage(response, parts.join(' | '));
        await sendWithDelay(parts, app.message, sourceChannel);
      } else if (visibleText) {
        const parts = ActionParser.splitMessages(visibleText);
        contextMgr.addAssistantMessage(response, visibleText);
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
      await ch.stop().catch(() => {});
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
    try {
      // 委托给 channel.sendMessages()，以确保 CLIChannel 的 isSendingBatch 逻辑正确工作
      await targetChannel.sendMessages(parts, msgCfg.minDelayMs, msgCfg.maxDelayMs, msgCfg.typingSpeedCharsPerSec);
      // 非 CLI 信道回复时，CLI 快速镜像显示（不带延迟，避免重复等待）
      if (cli && targetChannel !== cli) {
        const ts = formatCurrentTime();
        for (const part of parts) {
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

// ===== 命令注册 =====
/** 命令返回值：纯字符串通知，或带有可选 AI 触发事件的对象 */
export interface CommandResult {
  notice?: string;      // 显示给用户的确认文字（不经过AI）
  triggerEvent?: string; // 注入上下文并触发AI即时响应的事件描述
}

interface Systems {
  db: Database;
  emotionSys: EmotionSystem;
  healthSys: HealthSystem;
  memorySys: MemorySystem;
  relSys: RelationshipSystem;
  diarySys: DiarySystem;
  sleepSys: SleepSystem;
  newsSys: NewsSystem;
  scheduler: TaskScheduler;
  heartbeat: HeartbeatManager;
  shopSys: ShopSystem;
  character: { name: string };
  promptBuilder: PromptBuilder;
  contextMgr: ContextManager;
  userWorkSys: UserWorkSystem;
  workSys: WorkSystem;
  weatherSys: WeatherSystem;
  ai: AIClient;
  debugMode: boolean;
}

function registerCommands(add: (name: string, handler: (args: string[]) => Promise<string | CommandResult | void>) => void, sys: Systems): void {
  const { db, emotionSys, healthSys, memorySys, relSys,
          diarySys, sleepSys, newsSys, scheduler, heartbeat, shopSys,
          promptBuilder, contextMgr, userWorkSys, workSys, weatherSys, ai, debugMode } = sys;

  // /status
  add('status', async () => {
    const healthState = healthSys.getState();
    const rel = relSys.getState();
    const sleeping = sleepSys.isAsleep();
    const working = workSys.isWorking();
    const weather = weatherSys.getWeather();

    const healthVal = Math.round(healthState.healthValue);
    const fatigueVal = Math.round(healthState.fatigue);
    const affVal = Math.round(rel.affection);
    const affLabel = affVal >= 80 ? '挚友' : affVal >= 60 ? '好友' : affVal >= 40 ? '普通朋友' : affVal >= 20 ? '泛泛之交' : '陌生人';

    const diseaseStr = healthState.disease
      ? `\n  ${yellow('⚠️  患病:')} ${healthState.disease}（剩余约 ${healthState.diseaseDuration}h）` : '';
    const psychStr = healthState.psychologyState && healthState.psychologyState !== 'normal'
      ? `\n  ${magenta('🧠 心理:')} ${healthState.psychologyState}` : '';

    let activityStr = '';
    if (sleeping) {
      const wakeTime = sleepSys.getWakeTime();
      const wakeDesc = sleepSys.getWakeUpDescription();
      const wakeTimeStr = wakeTime
        ? `预计 ${wakeTime.getHours().toString().padStart(2,'0')}:${wakeTime.getMinutes().toString().padStart(2,'0')} 醒来`
        : '';
      activityStr = `\n  ${cyan('💤 睡眠中')} ${dim(wakeTimeStr ? `${wakeTimeStr}（${wakeDesc}）` : wakeDesc)}`;
    } else if (working) {
      const endTime = workSys.getEndTime();
      const workDesc = workSys.getWorkDescription();
      const endTimeStr = endTime
        ? `预计 ${endTime.getHours().toString().padStart(2,'0')}:${endTime.getMinutes().toString().padStart(2,'0')} 结束`
        : '';
      activityStr = `\n  ${yellow('💼 打工中')} ${dim(endTimeStr ? `${endTimeStr}（${workDesc}）` : workDesc)}`;
    }

    const weatherStr = weather
      ? `\n  ${dim('🌤️  天气:')} ${weather.city} ${weather.description} ${weather.temp}°C 湿度${weather.humidity}%`
      : '';

    return [
      titleBar('Ta 当前状态', '♡'),
      kv('🕐 时间', formatCurrentTime()),
      '',
      `  ${header('情绪')}`,
      `    ${emotionSys.toFullString()}`,
      `    ${dim('主导:')} ${bold(emotionSys.getMoodTag())}`,
      '',
      `  ${header('健康')}`,
      kv('❤️  健康', `${valueColor(healthVal, String(healthVal))} / 100`),
      kv('😴 疲惫', `${valueColor(100 - fatigueVal, String(fatigueVal))} / 100`),
      diseaseStr,
      psychStr,
      '',
      `  ${header('关系')}`,
      kv('💕 好感', `${valueColor(affVal, String(affVal))} / 100  ${dim(affLabel)}`),
      kv('💰 余额', `我: ${yellow(String(Math.round(rel.aiCurrency)))}  你: ${dim(String(Math.round(rel.userCurrency)))}`),
      activityStr,
      weatherStr,
      divider(),
    ].filter(l => l !== '').join('\n');
  });

  // /view_diary [date]
  // /view_diary [日期|u|d|页码|s 关键词]  — 查看日记，支持翻页与搜索
  let diaryPage = 1;
  add('view_diary', async (args) => {
    const arg = args[0] ?? '';
    const pageSize = 3;

    const fmtDiaries = (entries: any[]) => entries.map(e => {
      const d = new Date(e.createdAt);
      const timeStr = `${e.date} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      const mood = e.mood ? ` ${dim(`[${e.mood}]`)}` : '';
      return `  ${bold(cyan(timeStr))}${mood}\n${e.content.split('\n').map((l: string) => '  ' + l).join('\n')}`;
    }).join('\n\n' + dim('─'.repeat(40)) + '\n\n');

    if ((arg === 's' || arg === 'search') && args.slice(1).length > 0) {
      const keyword = args.slice(1).join(' ');
      const results = diarySys.search(keyword, 10);
      if (!results.length) return dim(`（没有找到包含「${keyword}」的日记）`);
      return `\n${bold(cyan(`🔍 日记搜索：「${keyword}」`))} ${dim(`(${results.length}条)`)}\n\n${fmtDiaries(results)}`;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      const entries = diarySys.get(arg);
      if (!entries.length) return dim(`（${arg} 没有日记）`);
      return `\n${bold(cyan(`📔 ${arg} 的日记`))}\n\n${fmtDiaries(entries)}`;
    }

    if (arg === 'u') {
      diaryPage = Math.max(1, diaryPage - 1);
    } else if (arg === 'd') {
      diaryPage += 1;
    } else if (arg && /^\d+$/.test(arg)) {
      diaryPage = parseInt(arg, 10) || 1;
    }

    const { entries, total, page: curPage, totalPages } = diarySys.getPage(diaryPage, pageSize);
    diaryPage = curPage;

    if (!entries.length) return dim('（还没有写过日记）');
    const prev = curPage > 1 ? green('/view_diary u') : '';
    const next = curPage < totalPages ? green('/view_diary d') : '';
    const navParts = [prev && `← ${prev}`, next && `${next} →`].filter(Boolean);
    const nav = dim(`第 ${curPage}/${totalPages} 页，共 ${total} 篇`) + (navParts.length ? `  ${navParts.join(dim(' | '))}` : '');
    return [
      titleBar('日记', '📔'),
      `  ${nav}`,
      '',
      fmtDiaries(entries),
      divider(),
    ].join('\n');
  });

  // /memories [search <关键词>]
  add('memories', async (args) => {
    const importanceColor = (n: number) => n >= 8 ? red(String(n)) : n >= 5 ? yellow(String(n)) : dim(String(n));
    const fmtMem = (m: any) => `  ${dim(`#${m.id}`)} ${dim(`[重要度:`)}${importanceColor(m.importance)}${dim(']')} ${m.content}`;

    if (args[0] === 'search' && args.slice(1).length > 0) {
      const query = args.slice(1).join(' ');
      const results = memorySys.recall(query, 20);
      if (!results.length) return dim(`（没有找到与"${query}"相关的记忆）`);
      return `\n${bold(cyan(`🔍 记忆搜索: "${query}"`))}  ${dim(`找到 ${results.length} 条`)}\n` +
        results.map(m => `  ${dim(`#${m.id}`)} ${dim('[' + m.level + '/重要度:')}${importanceColor(m.importance)}${dim(']')} ${m.content}`).join('\n') + '\n';
    }

    const perm = memorySys.getPermanentMemories();
    const long = db.getMemories('long').slice(0, 8);
    const short = db.getMemories('short').slice(0, 5);

    const fmtSection = (mems: any[], icon: string, label: string) => {
      if (!mems.length) return `\n  ${header(icon + ' ' + label)} ${dim('（空）')}`;
      return `\n  ${header(icon + ' ' + label)}\n` + mems.map(fmtMem).join('\n');
    };

    return [
      titleBar('记忆库', '🧠'),
      fmtSection(perm, '🔒', '永久记忆'),
      fmtSection(long, '📚', '长期记忆'),
      fmtSection(short, '💬', '短期记忆'),
      `\n  ${dim('提示: /memories search <关键词>  #号为记忆ID')}`,
      divider(),
    ].join('\n');
  });

  // /dreams
  add('dreams', async () => {
    const dreams = sleepSys.getRecentDreams(3);
    if (!dreams.length) return dim('（还没有梦境记录）');
    const typeIcon: Record<string, string> = {
      sweet: '🌸 美梦', nightmare: '😱 噩梦', weird: '🌀 奇异梦', neutral: '💭 梦境'
    };
    return [
      titleBar('梦境记录', '✨'),
      ...dreams.map(d => {
        const date = new Date(d.createdAt).toLocaleDateString('zh-CN');
        const icon = typeIcon[d.dreamType ?? 'neutral'] ?? '💭 梦境';
        const typeColor = d.dreamType === 'nightmare' ? red(icon)
          : d.dreamType === 'sweet' ? magenta(icon)
          : d.dreamType === 'weird' ? cyan(icon)
          : dim(icon);
        return `\n  ${typeColor}  ${dim(date)}\n${d.content.split('\n').map((l: string) => '  ' + l).join('\n')}`;
      }),
      divider(),
    ].join('\n');
  });

  // /give <item> <qty> | /give money <amount>
  add('give', async (args): Promise<string | CommandResult> => {
    if (!args.length) return '用法: /give <物品名> <数量> 或 /give money <金额>';
    if (args[0].toLowerCase() === 'money') {
      const amount = parseFloat(args[1] ?? '0');
      if (isNaN(amount) || amount <= 0) return '请输入有效金额';
      const ok = relSys.userToAi(amount);
      if (!ok) {
        const state = relSys.getState();
        return `余额不足！你的余额: ${Math.round(state.userCurrency)} 虚拟币`;
      }
      relSys.adjustAffection(2);
      memorySys.save('short', `他转账了 ${amount} 虚拟币给我`, 5);
      return {
        notice: `✅ 转账 ${amount} 虚拟币成功！好感度 +2`,
        triggerEvent: `[系统通知] 对方向你转账了 ${amount} 虚拟币。请自然地回应这份心意。`
      };
    } else {
      const itemName = args[0];
      const qty = parseInt(args[1] ?? '1', 10);
      if (isNaN(qty) || qty <= 0) return '请输入有效数量';
      const userItems = db.getInventory('user');
      const owned = userItems.find(i => i.itemName === itemName);
      if (!owned || owned.quantity < qty) {
        const has = owned?.quantity ?? 0;
        return `❌ 你的背包里只有 ${has} 个「${itemName}」，无法赠送 ${qty} 个`;
      }
      db.updateInventory('user', itemName, -qty);
      db.updateInventory('ai', itemName, qty);
      relSys.adjustAffection(1);
      memorySys.save('short', `他赠送了 ${qty} 个 ${itemName} 给我`, 5);
      return {
        notice: `✅ 赠送了 ${qty} 个「${itemName}」给Ta！好感度 +1`,
        triggerEvent: `[系统通知] 对方刚刚赠送了 ${qty} 个「${itemName}」给你。请自然地回应这份心意。`
      };
    }
  });

  // /tasks
  add('tasks', async () => {
    const raw = scheduler.formatForDisplay();
    if (!raw || raw.trim() === '（暂无任务）' || raw.trim() === '') return dim('（暂无任务）');
    return `${titleBar('任务列表', '📋')}\n${raw}\n${divider()}`;
  });

  // /news
  add('news', async () => {
    const news = sys.newsSys.getRecentNews(20);
    if (!news.length) return dim('（暂无新闻记录，等下次心跳自动获取）');
    const lines = news.map((n, idx) => {
      const shared = n.sharedAt ? green('✓') : dim('·');
      const src = n.source ? cyan(`[${n.source}]`) : '';
      let line = `  ${dim(String(idx).padStart(2, ' '))}. ${shared} ${src} ${bold(n.title)}`;
      if (n.summary) line += `\n     ${dim(n.summary.slice(0, 90))}${n.summary.length > 90 ? dim('…') : ''}`;
      if (n.url) line += `\n     ${dim('🔗')} ${dim(n.url)}`;
      return line;
    });
    return [
      titleBar('最近新闻', '📰'),
      ...lines,
      `  ${dim('/news_detail <序号>  查看新闻详情')}`,
      divider(),
    ].join('\n');
  });

  // /news_detail — 查看新闻详细内容
  add('news_detail', async (args) => {
    if (!args.length) return `用法: ${green('/news_detail <序号>')}`;
    const idx = parseInt(args[0], 10);
    if (isNaN(idx)) return '序号必须是数字';

    const detail = await sys.newsSys.getNewsDetail(idx);
    if (!detail) return red('❌ 新闻序号不存在');

    const lines: string[] = [
      titleBar('新闻详情', '📄'),
      `  ${bold(detail.title)}`,
      `  ${dim('来源:')} ${cyan(detail.source)}`,
    ];
    if (detail.url) lines.push(`  ${dim('链接:')} ${dim(detail.url)}`);

    if (detail.summary) {
      lines.push(`\n  ${header('📄 RSS摘要')}\n  ${detail.summary}`);
    } else if (detail.content) {
      lines.push(`\n  ${header('📄 内容')}\n  ${detail.content}`);
    } else if (detail.fetchError) {
      lines.push(`\n  ${yellow(`⚠️  无法获取详情: ${detail.fetchError}`)}`);
    } else {
      lines.push(`\n  ${dim('（该新闻暂无摘要，可通过链接查看原文）')}`);
    }
    lines.push(divider());
    return lines.join('\n');
  });

  // /inventory — 查看Ta的背包
  add('inventory', async () => {
    const items = db.getInventory('ai');
    if (!items.length) return dim(`（Ta的背包是空的）`);
    return [
      titleBar('Ta 的背包', '🎒'),
      ...items.map(i => `  ${dim('·')} ${i.itemName}  ${yellow('x' + i.quantity)}`),
      divider(),
    ].join('\n');
  });

  // /my_inventory — 查看自己的背包
  add('my_inventory', async () => {
    const items = db.getInventory('user');
    const rel = relSys.getState();
    const balanceLine = `  ${dim('💰 余额:')} ${yellow(Math.round(rel.userCurrency) + ' 虚拟币')}`;
    if (!items.length) return [
      titleBar('我的背包', '👜'),
      dim('  （背包空空如也）'),
      balanceLine,
      divider(),
    ].join('\n');
    return [
      titleBar('我的背包', '👜'),
      ...items.map(i => `  ${dim('·')} ${i.itemName}  ${yellow('x' + i.quantity)}`),
      balanceLine,
      divider(),
    ].join('\n');
  });

  // /shop — 查看商品列表
  add('shop', async (args) => {
    const rel = relSys.getState();
    const balanceLine = `  ${dim('💰 余额:')} ${yellow(Math.round(rel.userCurrency) + ' 虚拟币')}`;

    if (args[0]) {
      const matches = shopSys.findItems(args.join(' '));
      if (!matches.length) return dim(`未找到与「${args.join(' ')}」相关的商品`);
      return [
        titleBar(`商店搜索: "${args.join(' ')}"`, '🔍'),
        ...matches.map((item, i) =>
          `  ${dim(String(i + 1) + '.')} ${bold(item.name)}  ${yellow(String(item.price) + ' 虚拟币')}  ${dim(item.description)}`
        ),
        balanceLine,
        divider(),
      ].join('\n');
    }

    const allItems = shopSys.findItems('');
    if (!allItems.length) return dim('商店暂无商品');
    return [
      titleBar('商 店', '🛒'),
      ...allItems.map(item =>
        `  ${bold(item.name.padEnd(10))} ${yellow(String(item.price).padStart(5) + ' 虚拟币')}  ${dim(item.description)}`
      ),
      '',
      balanceLine,
      `  ${dim('购买:')} ${green('/buy <物品名> [数量]')}`,
      divider(),
    ].join('\n');
  });

  // 待选购买状态（模糊搜索命中多个时暂存）
  let pendingBuyItems: import('./systems/shop').ShopItem[] = [];
  let pendingBuyQty = 1;

  // /buy <物品名|序号> [数量]
  add('buy', async (args) => {
    if (!args.length) return '用法: /buy <物品名> [数量]  或搜索后输入序号选择';

    const lastArg = args[args.length - 1];
    const qty = parseInt(lastArg, 10);
    const hasQty = !isNaN(qty) && qty > 0 && args.length > 1;
    const queryOrIdx = hasQty ? args.slice(0, -1).join(' ') : args.join(' ');
    const buyQty = hasQty ? qty : 1;

    // 如果输入的是序号（且有待选列表）
    const idx = parseInt(queryOrIdx, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= pendingBuyItems.length) {
      const item = pendingBuyItems[idx - 1]!;
      pendingBuyItems = [];
      const result = shopSys.userBuy(item.name, buyQty);
      return result.message;
    }

    // 精确匹配
    const exactItem = shopSys.findItem(queryOrIdx);
    if (exactItem) {
      pendingBuyItems = [];
      return shopSys.userBuy(exactItem.name, buyQty).message;
    }

    // 模糊搜索
    const matches = shopSys.findItems(queryOrIdx);
    if (!matches.length) return `商店里没有「${queryOrIdx}」，试试 /shop <关键词> 搜索`;
    if (matches.length === 1) {
      pendingBuyItems = [];
      return shopSys.userBuy(matches[0]!.name, buyQty).message;
    }

    // 多个匹配 → 让用户选
    pendingBuyItems = matches.slice(0, 8);
    pendingBuyQty = buyQty;
    const lines = pendingBuyItems.map((item, i) =>
      `  ${dim(String(i + 1) + '.')} ${bold(item.name)}  ${yellow(String(item.price) + ' 虚拟币')}`
    );
    return `${cyan('?')} 找到 ${pendingBuyItems.length} 个匹配，请输入序号 ${dim('(如 /buy 1)')}\n${lines.join('\n')}`;
  });

  // /use <物品名> — 使用自己背包中的物品
  add('use', async (args) => {
    const itemName = args.join(' ');
    if (!itemName) return '用法: /use <物品名>';
    const result = shopSys.userUseItem(itemName);
    return result.message;
  });

  // /useitem <物品名> — 让Ta使用背包中的物品
  add('useitem', async (args) => {
    const itemName = args.join(' ');
    if (!itemName) return '用法: /useitem <物品名>';
    const result = shopSys.aiUseItem(itemName);
    if (!result.success) return result.message;
    return `✅ Ta使用了「${itemName}」。${result.message}`;
  });

  // /heartbeat
  add('heartbeat', async () => {
    logger.info('[Command] 手动触发心跳');
    await heartbeat.tick();
    return '心跳已触发';
  });

  // /wake [消息]  — 强制唤醒Ta，可附带聊天内容（在 handleUserMessage 特殊处理，此处仅备用）
  // 注意：实际处理逻辑在 handleUserMessage 的 /wake 特殊分支里，不走命令注册表

  // /context [prompt|history] — 查看当前 Prompt 和上下文用量
  add('context', async (args) => {
    const sub = (args[0] ?? '').toLowerCase();

    if (sub === 'prompt') {
      const prompt = promptBuilder.buildChatPrompt('（/context prompt）');
      return `${titleBar(`System Prompt  (~${countTextTokens(prompt)} tokens)`, '🧠')}\n${dim(prompt)}\n${divider()}`;
    }

    if (sub === 'history') {
      const history = await contextMgr.getHistory();
      const summary = contextMgr.getLatestSummary();
      if (!history.length && !summary) return dim('（暂无历史记录）');

      const parts: string[] = [
        titleBar(`上下文历史  (${history.length}条${summary ? '+摘要' : ''})`, '💬'),
      ];
      if (summary) {
        parts.push(`  ${header('📄 摘要（已合并入系统提示）')}\n  ${dim(summary)}`);
        parts.push(divider());
      }

      history.forEach((m, i) => {
        // 旧格式：系统消息时间注入（兼容历史数据）
        if (m.role === 'system' && m.content.startsWith('当前时间：')) {
          const timeStr = m.content.replace('当前时间：', '').trim();
          parts.push(dim(`\n  ─────────────── ${timeStr} ───────────────`));
          return;
        }
        let label: string;
        if (m.role === 'system') {
          label = yellow('📄 [摘要]');
        } else if (m.role === 'user') {
          label = green('👤 你');
        } else {
          label = magenta('💬 Ta');
        }
        // 检测时间前缀注入（格式: [2026-04-17 14:30]\n内容）
        const timePrefix = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n([\s\S]*)$/.exec(m.content);
        if (timePrefix) {
          parts.push(dim(`\n  ─────────────── ${timePrefix[1]} ───────────────`));
          parts.push(`  ${dim(`[${i + 1}]`)} ${bold(label)}\n  ${timePrefix[2]}`);
        } else {
          parts.push(`  ${dim(`[${i + 1}]`)} ${bold(label)}\n  ${m.content}`);
        }
        parts.push(dim('  · · ·'));
      });
      parts.push(divider());
      return parts.join('\n');
    }

    if (sub === 'clear') {
      contextMgr.clearHistory();
      return '✅ 对话历史已清空（记忆和状态未受影响）';
    }

    // 默认：统计信息
    const prompt = promptBuilder.buildChatPrompt('（/context）');
    const history = await contextMgr.getHistory();
    const summary = contextMgr.getLatestSummary();
    const promptTokens = countTextTokens(prompt);
    const summaryTokens = summary ? countTextTokens(summary) : 0;
    const historyTokens = countMessagesTokens(history);
    const totalTokens = promptTokens + summaryTokens + historyTokens;
    const perm = memorySys.getPermanentMemories().length;
    const long = db.getMemories('long').length;
    const short = db.getMemories('short').length;

    const bar = (tokens: number, max = totalTokens) => {
      const pct = Math.round((tokens / Math.max(max, 1)) * 20);
      return cyan('█'.repeat(pct)) + dim('░'.repeat(20 - pct));
    };

    return [
      titleBar('Context 用量', '📊'),
      kv('  🧠 System Prompt', `${yellow(`~${promptTokens}`)} tokens  ${bar(promptTokens)}`),
      summary ? kv('    └ 含摘要', `${dim(`~${summaryTokens}`)} tokens`) : null,
      kv('  💬 对话历史', `${yellow(`~${historyTokens}`)} tokens  ${bar(historyTokens)}  ${dim(`(${history.length}条)`)}`),
      kv('  📊 合计输入', `${bold(green(`~${totalTokens}`))} tokens`),
      '',
      `  ${header('📦 记忆库')}`,
      kv('    🔒 永久', `${cyan(String(perm))} 条`),
      kv('    📚 长期', `${cyan(String(long))} 条`),
      kv('    💬 短期', `${cyan(String(short))} 条`),
      '',
      `  ${dim('子命令:')} ${green('/context prompt')}  ${dim('查看完整系统提示词')}`,
      `          ${green('/context history')} ${dim('查看对话历史')}`,
      `          ${green('/context clear')}   ${dim('清空对话历史（记忆不受影响）')}`,
      divider(),
    ].filter(v => v !== null).join('\n');
  });

  // /clear — 清空终端屏幕
  add('clear', async () => {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    return '';
  });

  // /compress — 手动触发上下文压缩
  add('compress', async () => {
    return await contextMgr.forceCompress();
  });

  // /work [小时] | /work quit — 用户打工
  add('work', async (args) => {
    if (args[0]?.toLowerCase() === 'quit') {
      if (!userWorkSys.isWorking()) return '你没有在打工';
      const quit = userWorkSys.quitWork();
      if (quit.net > 0) {
        return `你跑路了 🏃 按劳动时间结算 ${quit.earnedBeforeFee} 虚拟币，扣除跑路费 ${quit.fee} 虚拟币，实得 ${quit.net} 虚拟币`;
      }
      return `你跑路了 🏃 劳动所得 ${quit.earnedBeforeFee} 虚拟币，扣除跑路费 ${quit.fee} 虚拟币，一分没落到`;
    }
    if (userWorkSys.isWorking()) {
      return `你已经在打工了 💼 ${userWorkSys.getWorkDescription()}`;
    }
    const hours = args[0] ? parseFloat(args[0]) : undefined;
    if (hours !== undefined && isNaN(hours)) return '请输入有效时长（小时）';
    const result = userWorkSys.startWork(hours);
    return `💼 你开始打工了！将在 ${result.endTime.toLocaleTimeString('zh-CN')} 下班（${result.durationHours.toFixed(1)}小时），预计赚取 ${result.expectedEarning} 虚拟币\n打工期间无法与Ta聊天。输入 /work quit 跑路（按实际时间结算后扣10虚拟币跑路费）`;
  });

  // /block — 用户屏蔽AI主动消息
  add('block', async () => {
    db.setBlacklistByUser(true);
    return `你屏蔽了Ta的主动消息 （Ta不会主动联系你了）\n输入 /unblock 解除屏蔽`;
  });

  // /unblock — 解除用户对AI的屏蔽
  add('unblock', async () => {
    const bl = db.getBlacklist();
    if (!bl.blacklistedByUser) {
      return '你没有屏蔽Ta的主动消息';
    }
    db.setBlacklistByUser(false);
    return `✅ 已解除屏蔽，Ta可以主动联系你了`;
  });

  // /apply_unblock — 申请解除AI的拉黑
  add('apply_unblock', async () => {
    const bl = db.getBlacklist();
    if (!bl.blacklistedByAi) {
      return '你没有被Ta拉黑，无需申请';
    }
    // 注入上下文给AI，等待下一次心跳处理
    contextMgr.addUserMessage('【用户请求】请解除对我的拉黑，我会好好表现的。');
    return `已向Ta提交解除拉黑的请求，等待下一次心跳给你答复...`;
  });

  // /stats
  add('stats', async () => {
    const stats = db.getStats();
    const rel = relSys.getState();

    let friendDays = '—';
    if (stats.firstMessageAt) {
      const days = Math.floor((Date.now() - stats.firstMessageAt) / 86400000);
      friendDays = `${days} 天`;
    }

    const stages = [
      [0, '陌生人'], [20, '点头之交'], [40, '普通朋友'],
      [60, '好朋友'], [80, '亲密朋友'], [100, '挚友']
    ];
    const stage = stages.reduce((prev, cur) => rel.affection >= (cur[0] as number) ? cur : prev, stages[0]);

    return [
      titleBar('关系统计', '💕'),
      kv('  ⏱️  结识', friendDays),
      kv('  💬 消息数', `${yellow(String(stats.totalMessages))} 条  ${dim(`(你: ${stats.userMessages}  Ta: ${stats.aiMessages})`)}`),
      kv('  ❤️  好感度', `${valueColor(Math.round(rel.affection), String(Math.round(rel.affection)))}  ${dim(stage[1] as string)}`),
      kv('  💰 虚拟币', `你 ${yellow(rel.userCurrency.toFixed(0))}  Ta ${cyan(rel.aiCurrency.toFixed(0))}`),
      kv('  📔 日记', `${yellow(String(stats.diaryCount))} 篇`),
      kv('  💭 梦境', `${yellow(String(stats.dreamCount))} 次`),
      divider(),
    ].join('\n');
  });

  // /birthday set MM-DD | /birthday — 已移除

  // /remind <内容> <HH:mm | YYYY-MM-DD HH:mm>
  add('remind', async (args) => {
    if (args.length < 2) {
      return '用法: /remind <提醒内容> <时间>\n时间格式: HH:mm（今天）或 YYYY-MM-DD HH:mm';
    }
    // 最后一个或两个参数是时间，其余是内容
    const lastArg = args[args.length - 1];
    const secondLast = args[args.length - 2];

    let triggerTime: number | null = null;
    let contentArgs: string[];

    // 尝试 YYYY-MM-DD H:mm 或 HH:mm 格式（最后两个参数）
    const timeRegex = /^\d{1,2}:\d{2}$/;
    if (args.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(secondLast) && timeRegex.test(lastArg)) {
      const [hh, mm] = lastArg.split(':').map(Number);
      const padded = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      triggerTime = new Date(`${secondLast}T${padded}:00`).getTime();
      contentArgs = args.slice(0, -2);
    } else if (timeRegex.test(lastArg)) {
      // H:mm 或 HH:mm 格式（今天）
      const [hh, mm] = lastArg.split(':').map(Number);
      const d = new Date();
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // 已过则明天
      triggerTime = d.getTime();
      contentArgs = args.slice(0, -1);
    } else {
      return '❌ 时间格式错误。请使用 H:mm（今天）或 YYYY-MM-DD H:mm';
    }

    if (!triggerTime || isNaN(triggerTime)) return '❌ 时间解析失败，请检查格式';

    const content = contentArgs.join(' ');
    if (!content) return '❌ 提醒内容不能为空';

    const triggerDate = new Date(triggerTime);
    const timeStr = `${triggerDate.getMonth() + 1}月${triggerDate.getDate()}日 ${String(triggerDate.getHours()).padStart(2,'0')}:${String(triggerDate.getMinutes()).padStart(2,'0')}`;

    scheduler.create(`提醒: ${content}`, new Date(triggerTime), content, 'user');
    return `✅ 已设置提醒：「${content}」将在 ${timeStr} 提醒你`;
  });

  // /weather
  add('weather', async () => {
    const w = await weatherSys.fetchWeather();
    if (!w) return red('❌ 天气获取失败，请检查网络或配置（config/app.yaml → weather.city）');
    return [
      titleBar('天气', '🌤️'),
      kv('  📍 城市', w.city),
      kv('  🌤️  天气', w.description),
      kv('  🌡️  温度', `${yellow(String(w.temp))}°C  ${dim(`体感 ${w.feelsLike}°C`)}`),
      kv('  💧 湿度', `${w.humidity}%`),
      kv('  💨 风速', `${w.windSpeed} km/h`),
      divider(),
    ].join('\n');
  });

  // /usage
  add('usage', async () => {
    const total = db.getApiUsageSummary();
    if (total.requestCount === 0) return dim('暂无 token 使用记录');

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = db.getApiUsageSummary(todayStart.getTime());
    const byModel = db.getApiUsageByModel();

    return [
      titleBar('Token 使用统计', '📈'),
      kv('  📊 总请求', `${yellow(String(total.requestCount))} 次`),
      kv('  📥 总输入', `${yellow(String(total.promptTokens))} tokens`),
      kv('  📤 总输出', `${yellow(String(total.completionTokens))} tokens`),
      kv('  🔢 总计', `${bold(green(String(total.totalTokens)))} tokens`),
      '',
      `  ${header('今日')}`,
      kv('    输入', `${yellow(String(today.promptTokens))} tokens`),
      kv('    输出', `${yellow(String(today.completionTokens))} tokens`),
      kv('    合计', `${green(String(today.totalTokens))} tokens  ${dim(`(${today.requestCount}次)`)}`),
      '',
      `  ${header('按模型')}`,
      ...byModel.map(item =>
        `  ${dim('·')} ${cyan(item.model)} ${dim('[' + item.endpoint + ']')}\n    ${dim('输入')} ${yellow(String(item.promptTokens))} / ${dim('输出')} ${yellow(String(item.completionTokens))} / ${dim('合计')} ${green(String(item.totalTokens))} ${dim(`(${item.requestCount}次)`)}`
      ),
      divider(),
    ].join('\n');
  });

  // /debug — 调试命令组（需在 app.yaml 中设置 debug: true 开启）
  add('debug', async (args) => {
    if (!debugMode) return '⚠️ 调试模式未开启，请在 app.yaml 中设置 debug: true';
    const sub = (args[0] ?? '').toLowerCase();

    switch (sub) {
      case 'unblock': {
        db.setBlacklistByAi(false);
        db.setBlacklistByUser(false);
        return '✅ [DEBUG] 已强制解除所有拉黑/屏蔽状态';
      }
      case 'sleep': {
        const hours = parseFloat(args[1] ?? '1');
        const h = isNaN(hours) ? 1 : hours;
        sleepSys.startSleep(h);
        return `✅ [DEBUG] 已强制她进入睡眠，持续 ${h} 小时`;
      }
      case 'wake': {
        sleepSys.forceWakeUp();
        return '✅ [DEBUG] 已强制唤醒';
      }
      case 'emotion': {
        // /debug emotion joy=80 sadness=10
        const changes: Record<string, number> = {};
        for (const part of args.slice(1)) {
          const [k, v] = part.split('=');
          if (k && v) changes[k] = parseFloat(v);
        }
        if (Object.keys(changes).length === 0) {
          return `当前情绪:\n${emotionSys.toFullString()}`;
        }
        emotionSys.update(changes);
        return `✅ [DEBUG] 情绪已调整:\n${emotionSys.toFullString()}`;
      }
      case 'health': {
        // /debug health health=80 fatigue=20
        const h = parseFloat(args.find(a => a.startsWith('health='))?.split('=')[1] ?? 'NaN');
        const f = parseFloat(args.find(a => a.startsWith('fatigue='))?.split('=')[1] ?? 'NaN');
        if (!isNaN(h) || !isNaN(f)) {
          healthSys.adjust({ health: isNaN(h) ? 0 : h - healthSys.getHealth(), fatigue: isNaN(f) ? 0 : f - healthSys.getFatigue() });
          return `✅ [DEBUG] 健康值已调整:\n${healthSys.toPromptString()}`;
        }
        return `当前健康状态:\n${healthSys.toPromptString()}`;
      }
      case 'favor': {
        const val = parseFloat(args[1] ?? 'NaN');
        if (!isNaN(val)) {
          relSys.setFavorDirect(val);
          return `✅ [DEBUG] 好感度已设置为 ${val}`;
        }
        return `当前好感度: ${relSys.getState().affection}`;
      }
      case 'work_stop': {
        if (!workSys.isWorking()) return '[DEBUG] Ta 当前没有在打工';
        workSys.forceStop();
        return '✅ [DEBUG] 已强制让 Ta 下班（无回来流程）';
      }
      case 'work_finish': {
        if (!workSys.isWorking()) return '[DEBUG] Ta 当前没有在打工';
        heartbeat.forceWorkEnd();
        return '✅ [DEBUG] 已强制完成打工，正在触发回来流程...';
      }
      case 'sleep_dream': {
        const hours = parseFloat(args[1] ?? '1');
        const h = isNaN(hours) ? 1 : hours;
        sleepSys.startSleep(h);
        await new Promise(r => setTimeout(r, 300));
        heartbeat.forceDream();
        return `✅ [DEBUG] 已强制她进入睡眠（${h}h），并立即触发梦境生成`;
      }
      case 'wake_natural': {
        if (!sleepSys.isAsleep()) return '[DEBUG] Ta 当前没有在睡觉';
        heartbeat.forceWakeAndProcess();
        return '✅ [DEBUG] 已强制她自然醒，正在触发起床流程...';
      }
      case 'tick': {
        heartbeat.forceTick();
        return '✅ [DEBUG] 已触发一次心跳';
      }
      case 'reset_chat':
      case 'reset-chat': {
        contextMgr.clearHistory();
        db.clearMemories(['short', 'long']);
        return '✅ [DEBUG] 已重置聊天数据（已清空对话历史、短期记忆、长期记忆；保留永久记忆）';
      }
      case 'news': {
        try {
          const fetched = await newsSys.fetchNews(true);  // 强制刷新
          const all = newsSys.getRecentNews(20);
          if (!all.length) return '[DEBUG] 获取到 0 条新闻（源可能无新内容）';
          const header = `===== 最新新闻（已强制刷新，本次新增 ${fetched.length} 条）=====`;
          return header + '\n' + all.map((n: any, i: number) => {
            const shared = n.sharedAt ? '✓' : '·';
            const sumPreview = n.summary ? ` — ${n.summary.slice(0, 60)}...` : '';
            return `${shared} ${i}. ${n.title} (${n.source})${sumPreview}`;
          }).join('\n');
        } catch (e) {
          return `[DEBUG] 获取新闻失败: ${e}`;
        }
      }
      case 'weather': {
        const w = weatherSys.getWeather();
        if (!w) return '[DEBUG] 暂无天气缓存，正在获取...\n' + await weatherSys.fetchWeather().then(r => r ? `${r.city} ${r.description} ${r.temp}°C` : '获取失败');
        return `[DEBUG] 天气: ${w.city} ${w.description} ${w.temp}°C（体感${w.feelsLike}°C）湿度${w.humidity}% 风速${w.windSpeed}km/h`;
      }
      case 'currency': {
        // /debug currency [user|ai] <金额>  — 为用户/AI增加虚拟币（上限500）
        const target = (args[1] ?? 'user') as 'user' | 'ai';
        const rawAmt = parseFloat(args[2] ?? args[1] ?? 'NaN');
        if (isNaN(rawAmt)) {
          const st = relSys.getState();
          return `[DEBUG] 当前余额 — 用户: ${st.userCurrency}，Ta: ${st.aiCurrency}`;
        }
        if (!['user', 'ai'].includes(target)) return '[DEBUG] 用法: /debug currency [user|ai] <金额>';
        const capped = Math.min(500, Math.max(0, Math.round(rawAmt)));
        relSys.adjustCurrency(target, capped);
        const newBal = relSys.getState();
        return `✅ [DEBUG] 已为${target === 'user' ? '用户' : 'Ta'}增加 ${capped} 虚拟币（单次上限500）\n用户余额: ${newBal.userCurrency}，Ta余额: ${newBal.aiCurrency}`;
      }
      case 'naked': {
        // 忽略所有上下文/记忆，仅带行动标签文档直接调用模型
        const nakedMsg = args.join(' ').trim();
        if (!nakedMsg) return '[DEBUG] 用法: /debug naked <消息内容>';
        const tagDoc = promptBuilder.getTagInstructionsPublic('chat');
        const nakedSysPrompt = `你是一个AI助手，理解以下行动标签并在回复中使用它们。\n${tagDoc}`;
        const nakedMessages = [
          { role: 'system' as const, content: nakedSysPrompt },
          { role: 'user' as const, content: nakedMsg },
        ];
        try {
          const rawResp = await ai.chat(nakedMessages);
          return `[DEBUG naked 原始输出]\n${rawResp}`;
        } catch (e) {
          return `[DEBUG naked] 调用失败: ${e}`;
        }
      }
      case 'del_msg': {
        // 删除指定上下文消息
        // 支持两种写法：/debug del_msg <序号>  或  /debug del_msg id:<DB_ID>
        const idxStr = args[1];
        if (!idxStr) {
          // 显示带 DB ID 的历史供用户选择
          const rows = contextMgr.getHistoryWithIds();
          if (!rows.length) return '[DEBUG] 当前无对话历史';
          const lines = rows.map((m, i) => {
            const label = m.role === 'user' ? '你' : 'Ta';
            const preview = (m.contentVisible || m.content).replace(/\n/g, ' ').slice(0, 60);
            return `  [${i + 1}] (DB#${m.id}) ${label}: ${preview}`;
          });
          return `[DEBUG] 用法:\n  /debug del_msg <序号>     — 按列表序号删除（如 /debug del_msg 15）\n  /debug del_msg id:<DB_ID> — 按 DB ID 删除（如 /debug del_msg id:40）\n当前历史:\n${lines.join('\n')}`;
        }
        // 支持 id:N 语法（直接用 DB ID）
        if (idxStr.toLowerCase().startsWith('id:')) {
          const dbId = parseInt(idxStr.slice(3), 10);
          if (isNaN(dbId)) return '[DEBUG] 无效 DB ID';
          const ok = contextMgr.deleteMessageById(dbId);
          return ok ? `✅ [DEBUG] DB#${dbId} 已删除` : `[DEBUG] DB ID ${dbId} 不存在`;
        }
        const idx = parseInt(idxStr, 10);
        if (isNaN(idx) || idx < 1) return '[DEBUG] 无效序号（纯数字视为序号，DB ID 请用 id:40 格式）';
        const ok = contextMgr.deleteMessageByIndex(idx);
        return ok ? `✅ [DEBUG] 第 ${idx} 条消息已删除` : `[DEBUG] 序号 ${idx} 不存在`;
      }
      default:
        return [
          '===== 调试命令 (debug: true 模式) =====',
          '/debug unblock              — 强制解除所有拉黑/屏蔽',
          '/debug sleep [小时]          — 强制进入睡眠',
          '/debug sleep_dream [小时]    — 强制进入睡眠并立即触发梦境',
          '/debug wake                 — 强制唤醒（不触发起床流程）',
          '/debug wake_natural         — 强制自然醒（触发完整起床流程）',
          '/debug emotion [key=val]    — 查看/设置情绪值',
          '/debug health [health=N fatigue=N] — 查看/设置健康值',
          '/debug favor [数值]          — 查看/设置好感度',
          '/debug currency [user|ai] <金额>  — 增加虚拟币（单次上限500）',
          '/debug work_stop             — 强制让 Ta 下班（无回来流程）',
          '/debug work_finish           — 强制完成打工（触发完整回来流程）',
          '/debug tick                 — 手动触发一次心跳',
          '/debug reset_chat           — 重置聊天数据（保留永久记忆）',
          '/debug news                 — 实时获取新闻',
          '/debug weather              — 查看天气缓存',
          '/debug naked <消息>          — 忽略上下文仅带标签文档调用模型（测试原始输出）',
          '/debug del_msg [序号]        — 删除指定上下文消息（不带序号时列出所有消息）',
        ].join('\n');
    }
  });

  // /help
  add('help', async () => {
    const cmd = (c: string, desc: string) => `  ${green(c.padEnd(40))} ${dim(desc)}`;
    const sec = (title: string) => `\n  ${header(title)}`;
    const debugLine = debugMode ? cmd('/debug', '调试命令（debug模式）') : '';
    return [
      titleBar('可用命令', '📖'),
      sec('状态'),
      cmd('/status', '查看Ta的当前状态'),
      cmd('/stats', '查看关系统计数据'),
      cmd('/weather', '查看当前天气'),
      cmd('/usage', '查看模型 token 总使用量'),
      sec('日记 / 梦境'),
      cmd('/view_diary [日期|页码|u|d]', '查看日记（日期YYYY-MM-DD，数字/u/d翻页，s 搜索）'),
      cmd('/dreams', '查看梦境记录'),
      sec('记忆 / 上下文'),
      cmd('/memories [search <关键词>]', '查看/搜索记忆'),
      cmd('/context [prompt|history|clear]', 'Token用量/系统提示词/历史/清空'),
      cmd('/compress', '手动触发上下文压缩'),
      sec('新闻'),
      cmd('/news', '查看最近新闻列表'),
      cmd('/news_detail <序号>', '查看新闻详细内容'),
      sec('关系 / 互动'),
      cmd('/give <物品> <数量>', '赠送物品给Ta'),
      cmd('/give money <金额>', '给Ta转账虚拟币'),
      sec('任务 / 提醒'),
      cmd('/tasks', '查看任务列表'),
      cmd('/remind <内容> <时间>', '设置提醒（时间: HH:mm 或 YYYY-MM-DD HH:mm）'),
      sec('背包 / 商店'),
      cmd('/inventory', '查看Ta的背包'),
      cmd('/my_inventory', '查看自己的背包'),
      cmd('/shop [关键词]', '查看/搜索商店'),
      cmd('/buy <物品|序号> [数量]', '购买物品（支持模糊搜索）'),
      cmd('/use <物品>', '使用自己的物品'),
      cmd('/useitem <物品>', '让Ta使用物品'),
      sec('系统'),
      cmd('/wake [消息]', '强制唤醒Ta（可附带消息）'),
      cmd('/work [小时]', '去打工赚钱（打工期间无法与Ta聊天）'),
      cmd('/work quit', '跑路（没有工资）'),
      cmd('/channel [信道名]', '查看或切换活跃信道（AI回复目标）'),
      cmd('/preferred-channel [信道名]', '设置优先信道（优先发送到该信道，即使未激活）'),
      cmd('/block', '屏蔽Ta的主动消息'),
      cmd('/unblock', '解除屏蔽'),
      cmd('/apply_unblock', '申请解除拉黑'),
      cmd('/clear', '清空终端屏幕'),
      cmd('/api <消息>', '直接调用AI接口（不带上下文，用于测试）'),
      debugLine,
      divider(),
    ].filter(v => v !== '').join('\n');
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
