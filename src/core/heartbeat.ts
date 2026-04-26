/**
 * 心跳管理器
 * 负责定期"唤醒"AI，让她进行自主行为
 */
import { AIClient } from './ai';
import { ActionParser } from './actionParser';
import { ActionExecutor } from './actionExecutor';
import { PromptBuilder } from './promptBuilder';
import { ContextManager } from './context';
import { EmotionSystem } from '../systems/emotion';
import { HealthSystem } from '../systems/health';
import { MemorySystem } from '../systems/memory';
import { RelationshipSystem } from '../systems/relationship';
import { SleepSystem } from '../systems/sleep';
import { WorkSystem } from '../systems/work';
import { NewsSystem } from '../systems/news';
import { TaskScheduler } from '../systems/scheduler';
import { DiarySystem } from '../systems/diary';
import { HeartbeatConfig, NewsConfig } from '../config/types';
import { logger } from '../utils/logger';
import { formatCurrentTime } from '../utils/time';

export type SendMessageFn = (messages: string[]) => Promise<void>;
export type DebugNotifyFn = (msg: string) => Promise<void>;

export class HeartbeatManager {
  private timer: NodeJS.Timeout | null = null;
  private taskWatcher: NodeJS.Timeout | null = null;  // 独立任务监听器
  private nextIntervalMs: number;
  private isRunning = false;
  private aiCallActive = false;  // AI调用锁，防止并发调用
  private lastAiBusyLogTime = 0;
  private getLastInteractionTime?: () => number;

  /** 外部（callAI）通知心跳：当前是否有AI调用正在进行，避免双重输出 */
  setExternalAIBusy(busy: boolean): void {
    this.aiCallActive = busy;
  }

  setLastInteractionGetter(fn: () => number): void {
    this.getLastInteractionTime = fn;
  }

  constructor(
    private ai: AIClient,
    private actionExecutor: ActionExecutor,
    private promptBuilder: PromptBuilder,
    private contextManager: ContextManager,
    private emotionSys: EmotionSystem,
    private healthSys: HealthSystem,
    private memorySys: MemorySystem,
    private relSys: RelationshipSystem,
    private sleepSys: SleepSystem,
    private newsSys: NewsSystem,
    private scheduler: TaskScheduler,
    private diarySys: DiarySystem,
    private cfg: HeartbeatConfig,
    private sendMessage: SendMessageFn,
    private newsConfig: NewsConfig,
    private workSys?: WorkSystem,
    private debugNotify?: DebugNotifyFn,
    /** 系统通知专用函数（如打工状态、睡觉提示等），默认与sendMessage相同 */
    private sendSystemNotice?: SendMessageFn
  ) {
    this.nextIntervalMs = cfg.intervalMinutes * 60 * 1000;
    // 若未提供专用通知函数，复用 sendMessage
    if (!this.sendSystemNotice) this.sendSystemNotice = sendMessage;
  }

  /** 发送系统级通知（状态变化、提示等），可按配置限制信道 */
  private async notifySystem(msgs: string[]): Promise<void> {
    await this.sendSystemNotice!(msgs);
  }

  private async sendDebug(label: string, actions: import('./actionParser').ParsedAction[]): Promise<void> {
    if (!this.debugNotify || !actions.length) return;
    await this.debugNotify(ActionParser.formatForDebug(actions));
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`[Heartbeat] 心跳系统启动，间隔=${this.cfg.intervalMinutes}分钟`);
    this.scheduleNext();
    this.startTaskWatcher();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.taskWatcher) clearInterval(this.taskWatcher);
    this.timer = null;
    this.taskWatcher = null;
    this.isRunning = false;
    logger.info('[Heartbeat] 心跳系统停止');
  }

  /** 独立任务监听器：每N秒检查到期任务、睡眠结束、打工结束，快速响应，不依赖心跳 */
  private startTaskWatcher(): void {
      const intervalMs = (this.cfg.taskWatchIntervalSeconds ?? 30) * 1000;
      this.taskWatcher = setInterval(async () => {
        try {
          // 1. 检查睡眠是否结束（优先级最高）
          const justWoke = this.sleepSys.checkWakeUp();
          if (justWoke) {
            if (this.aiCallActive) {
              logger.info(`[TaskWatcher] AI正忙，起床消息稍后处理`);
              // 标记需要延迟处理，或者直接返回
              return;
            }
            logger.info(`[TaskWatcher] Ta醒来了`);
            this.aiCallActive = true;
            try { await this.handleWakeUp(); } finally { this.aiCallActive = false; }
            return;
          }
    
          // 2. 如果在睡觉，跳过（做梦留给心跳处理）
          if (this.sleepSys.isAsleep()) return;
    
          // 3. 检查打工是否结束
          if (this.workSys) {
            const workEnd = this.workSys.checkWorkEnd();
            if (workEnd) {
              if (this.aiCallActive) {
                logger.info(`[TaskWatcher] AI正忙，打工结束消息稍后处理`);
                return;
              }
              logger.info(`[TaskWatcher] Ta打工结束，赚了 ${workEnd.earned} 元`);
              this.memorySys.save('short', `打工结束，赚了 ${workEnd.earned} 元`, 4);
              this.aiCallActive = true;
              try { await this.handleWorkEnd(workEnd.hours, workEnd.earned); } finally { this.aiCallActive = false; }
            }
          }
    
          // 4. 如果还在打工，跳过后续任务处理
          if (this.workSys?.isWorking()) return;
    
          // 5. 处理到期任务
          const dueTasks = this.scheduler.getDueTasks();
          if (dueTasks.length === 0) return;
    
          // 分离用户任务和 AI 任务
          const aiTaskNames: string[] = [];
          const userTasks: typeof dueTasks = [];
    
          for (const task of dueTasks) {
            if (task.createdBy === 'user') {
              userTasks.push(task);
            } else {
              aiTaskNames.push(`${task.name}${task.description ? '：' + task.description : ''}`);
            }
          }
    
          // 6. 用户任务：立即执行，不受 AI 忙碌影响
          for (const task of userTasks) {
            this.scheduler.complete(task.id!);
            logger.info(`[TaskWatcher] 执行用户任务: ${task.name}`);
    
            // 执行任务附带的行动标签
            if (task.actionTags) {
              const tagActions = ActionParser.parse(task.actionTags).actions;
              if (tagActions.length > 0) {
                logger.info(`[TaskWatcher] 执行任务行动标签: ${task.name}`);
                await this.actionExecutor.execute(tagActions);
              }
            }
    
            // 发送提醒通知
            const reminder = task.description || task.name;
            await this.notifySystem([`⏰ 提醒：${reminder}`]);
            logger.info(`[TaskWatcher] 用户任务提醒已发送: ${reminder}`);
          }
    
          // 7. AI 任务：需要等 AI 空闲才能触发
          if (aiTaskNames.length > 0) {
            if (this.aiCallActive) {
              const now = Date.now();
              if (now - this.lastAiBusyLogTime > 60_000) {
                logger.info(`[TaskWatcher] AI正忙，${aiTaskNames.length} 个AI任务延迟到下次检查`);
                this.lastAiBusyLogTime = now;
              }
              return;  // AI 忙，跳过本次，等下次心跳再试
            }
            
            // 先完成任务标记
            for (const task of dueTasks.filter(t => t.createdBy !== 'user')) {
              this.scheduler.complete(task.id!);
              
              // 执行任务附带的行动标签
              if (task.actionTags) {
                const tagActions = ActionParser.parse(task.actionTags).actions;
                if (tagActions.length > 0) {
                  logger.info(`[TaskWatcher] 执行AI任务行动标签: ${task.name}`);
                  await this.actionExecutor.execute(tagActions);
                }
              }
            }
            
            this.aiCallActive = true;
            try { 
              await this.aiDecision(aiTaskNames); 
            } finally { 
              this.aiCallActive = false; 
            }
          }
        } catch (e) {
          logger.debug(`[TaskWatcher] 检查失败: ${e}`);
          this.aiCallActive = false;
        }
      }, intervalMs);
      logger.info(`[TaskWatcher] 任务监听器已启动，检查间隔=${this.cfg.taskWatchIntervalSeconds ?? 30}s`);
  }

  /** 手动触发一次心跳（测试用） */
  async tick(): Promise<void> {
    await this.doTick();
  }

  /** 强制立即触发心跳（调试用别名） */
  forceTick(): void {
    this.doTick().catch(e => logger.error(`[Heartbeat] forceTick 错误: ${e}`));
  }

  /** DEBUG: 强制结束打工并触发回来流程 */
  forceWorkEnd(): void {
    if (!this.workSys) return;
    const state = this.workSys.getState();
    const hours = state?.durationHours ?? 1;
    const earned = Math.round(hours * (state?.earningRate ?? 10));
    this.workSys.forceStop();
    this.memorySys.save('short', `打工结束，赚了 ${earned} 元`, 4);
    this.handleWorkEnd(hours, earned).catch(e => logger.error(`[Heartbeat] forceWorkEnd 错误: ${e}`));
  }

  /** DEBUG: 强制唤醒并触发起床流程 */
  forceWakeAndProcess(): void {
    this.sleepSys.forceWakeUp();
    this.handleWakeUp().catch(e => logger.error(`[Heartbeat] forceWakeAndProcess 错误: ${e}`));
  }

  /** DEBUG: 强制触发梦境生成（需在睡眠中） */
  forceDream(): void {
    this.generateDream().catch(e => logger.error(`[Heartbeat] forceDream 错误: ${e}`));
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      await this.doTick();
      this.scheduleNext();
    }, this.nextIntervalMs);
  }

  private async doTick(): Promise<void> {
    if (this.aiCallActive) {
      logger.info('[Heartbeat] AI正忙（用户任务执行中），跳过本次心跳');
      return;
    }
    logger.info(`[Heartbeat] ⏰ 心跳触发 ${formatCurrentTime()}`);
    // 每次心跳开始前重置为默认间隔，AI 可通过 NEXT_HEARTBEAT 覆盖
    this.nextIntervalMs = this.cfg.intervalMinutes * 60 * 1000;
    this.aiCallActive = true;

    try {
      // 1. 睡觉和打工状态由 taskWatcher 处理，心跳只跳过即可
      if (this.sleepSys.isAsleep()) {
        logger.info(`[Heartbeat] Ta正在睡觉，跳过心跳`);
        // 做梦仍由心跳处理（低频）
        if (this.sleepSys.shouldDream()) {
          await this.generateDream();
        }
        return;
      }

      // 2. 健康/情绪/记忆/关系衰减tick
      const emoState = this.emotionSys.getState();
      this.healthSys.tick(emoState.joy, this.cfg.intervalMinutes, this.relSys.getState().affection, emoState);
      this.emotionSys.decay();
      this.memorySys.decay();
      this.relSys.decay();

      // 3. 如果在打工，跳过AI决策
      if (this.workSys?.isWorking()) {
        logger.info(`[Heartbeat] Ta正在打工，跳过AI决策`);
        return;
      }

      // 4. 如果刚被手动唤醒，等用户先发话
      if (this.sleepSys.wasRecentlyForceWoken()) {
        logger.info(`[Heartbeat] Ta刚被手动唤醒，等待用户发起对话`);
        return;
      }

      // 5. 如果太累，强制入睡
      const fatigue = this.healthSys.getFatigue();
      const forceSleep = this.sleepSys.shouldForceSleepForFatigue(fatigue);
      const preferSleep = this.sleepSys.shouldSleepForFatigue(fatigue);
      if (forceSleep || (preferSleep && this.sleepSys.isSleepTime())) {
        const health = this.healthSys.getState();
        const result = this.sleepSys.startSleep(undefined, health.healthValue, emoState.joy);
        this.memorySys.save('short', `太累了，决定先睡一觉（疲惫 ${Math.round(fatigue)}）`, 5);
        await this.notifySystem([`太累了，先去睡一会儿，预计 ${result.durationHours}h 后醒来`]);
        logger.info(`[Heartbeat] 疲惫过高(${Math.round(fatigue)})，已进入睡眠`);
        return;
      }

      // 6. 获取新闻（如果启用且概率触发）
      const newsFetchEnabled = this.newsConfig.enabled !== false;
      const newsFetchProb = this.cfg.newsFetchProbability ?? 0.35;
      if (newsFetchEnabled && Math.random() < newsFetchProb) {
        try {
          await this.newsSys.fetchNews();
        } catch (e) {
          logger.debug(`[Heartbeat] 新闻获取失败: ${e}`);
        }
      }

      // 7. 随机生活事件（以概率触发）
      const randomEventProb = this.cfg.randomEventProbability ?? 0.2;
      const randomEvent = Math.random() < randomEventProb ? this.pickRandomEvent() : null;
      const fatiguePrompt = preferSleep ? '你现在很疲惫，应优先考虑睡觉或减少活动。' : null;

      // 8. 让AI决策（心跳本身不处理到期任务，由taskWatcher负责）
      await this.aiDecision([], [randomEvent, fatiguePrompt].filter(Boolean).join('\n') || undefined);

    } catch (err) {
      logger.error(`[Heartbeat] 心跳处理错误: ${err}`);
    } finally {
      this.aiCallActive = false;
    }
  }

  private async aiDecision(triggeredTasks: string[] = [], randomEvent?: string): Promise<void> {
    const systemPrompt = this.promptBuilder.buildHeartbeatPrompt();
    const history = await this.contextManager.getHistory();
    const summary = this.contextManager.getLatestSummary();
    const fullSystemPrompt = summary
      ? `${systemPrompt}\n\n[对话历史摘要]\n${summary}`
      : systemPrompt;

    // 22:00 ± 30min 随机触发日记提醒（今天未写过则加提示）
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const totalMin = hour * 60 + minute;
    const diaryWindowStart = 21 * 60 + 30;  // 21:30
    const diaryWindowEnd   = 23 * 60;        // 23:00
    const shouldNudgeDiary = totalMin >= diaryWindowStart
      && totalMin <= diaryWindowEnd
      && !this.diarySys.hasWrittenToday();
    const diaryNudge = shouldNudgeDiary ? ' 今天还没写日记，可以考虑写一篇。' : '';

    // 随机事件提示
    const eventNote = randomEvent ? ` 另外，刚刚发生了一件事：${randomEvent}` : '';

    // 注入未读新闻（加概率门控，注入后立即标记为已看，避免反复出现）
    const newsEnabled = this.newsConfig.enabled !== false;
    let newsNote = '';
    const newsInjectProb = 0.4;  // 40% 概率注入当次未读新闻
    if (newsEnabled && Math.random() < newsInjectProb) {
      const unshared = this.newsSys.getUnsharedNews(2);
      if (unshared.length > 0) {
        newsNote = '\n刚看到的资讯（可以分享感兴趣的给对方）：\n' +
          unshared.map(n => `· [${n.source}] ${n.title}${n.summary ? '——' + n.summary.slice(0, 80) : ''}`).join('\n');
        // 注入后立即标记为已看，下次心跳不再重复注入
        for (const n of unshared) {
          if (n.id) this.newsSys.markShared(n.id);
        }
      }
    }

    // 构建心跳用户消息：区分定时任务触发 vs 自由时间
    let heartbeatMsg: string;

    // 用户不活跃时长提示
    let inactivityNote = '';
    if (this.getLastInteractionTime) {
      const lastInteract = this.getLastInteractionTime();
      if (lastInteract > 0) {
        const minutesInactive = Math.floor((Date.now() - lastInteract) / 60_000);
        if (minutesInactive >= 60) {
          const hoursInactive = Math.floor(minutesInactive / 60);
          inactivityNote = ` 对方已有 ${hoursInactive > 0 ? hoursInactive + '小时' : ''}${minutesInactive % 60}分钟未发消息。`;
        }
      }
    }

    if (triggeredTasks.length > 0) {
      heartbeatMsg = `[系统心跳 ${formatCurrentTime()}] 以下定时任务已到触发时间，请根据任务内容做出相应行动：\n${triggeredTasks.map(t => `· ${t}`).join('\n')}${eventNote}${newsNote}`;
    } else {
      heartbeatMsg = `[系统心跳 ${formatCurrentTime()}] 根据当前状态，决定做什么：可以主动联系对方、写日记、工作、或者什么都不做。${diaryNudge}${inactivityNote}${eventNote}${newsNote}`;
    }

    const messages: any[] = [
      { role: 'system' as const, content: fullSystemPrompt },
      // 时间/状态/记忆独立注入为第一条 assistant 消息（保持 system 稳定以利 cache）
      { role: 'assistant' as const, content: this.promptBuilder.buildHeartbeatContextMessage() },
      ...history.slice(-16),  // 心跳时只带最近16条历史
      {
        role: 'user' as const,
        content: heartbeatMsg
      }
    ];

    const response = await this.ai.chat(messages, 0.85);
    const { actions, visibleText } = ActionParser.parse(response);
    await this.sendDebug('心跳标签', actions);
    const result = await this.actionExecutor.execute(actions);

    // 设置下次心跳间隔
    if (result.nextHeartbeatMinutes) {
      this.nextIntervalMs = Math.max(
        this.cfg.minIntervalMinutes,
        Math.min(this.cfg.maxIntervalMinutes, result.nextHeartbeatMinutes)
      ) * 60 * 1000;
      logger.info(`[Heartbeat] 下次心跳间隔设为 ${result.nextHeartbeatMinutes} 分钟`);
    }

    // 发送主动消息
    if (result.messagesToSend.length > 0) {
      logger.info(`[Heartbeat] Ta主动发送 ${result.messagesToSend.length} 条消息`);
      await this.sendMessage(result.messagesToSend);
      this.contextManager.addAssistantMessage(response, result.messagesToSend.join(' '));
    }

    if (result.sleepStarted) {
      const wakeDesc = this.sleepSys.getWakeUpDescription();
      logger.info(`[Heartbeat] Ta去睡觉了 ${wakeDesc}`);
    }

    if (result.workStarted && this.workSys) {
      logger.info(`[Heartbeat] Ta开始打工了 ${this.workSys.getWorkDescription()}`);
    }

    if (result.noAction) {
      logger.info(`[Heartbeat] Ta本次心跳选择无动作`);
    }

    // 如果有未展示给用户的可见文本，暂存为短期记忆
    if (visibleText && visibleText.length > 5 && result.messagesToSend.length === 0) {
      this.memorySys.save('short', `[心跳内心活动] ${visibleText.slice(0, 100)}`, 2);
    }
  }

  private async generateDream(): Promise<void> {
    try {
      // 40% 概率生成与现实无关的自由梦境，使梦境多样化
      const freeform = Math.random() < 0.4;
      const recentMems = freeform ? '' : this.memorySys.getShortTermSummary();
      const emoSummary = this.emotionSys.toPromptString();
      const mood = this.emotionSys.getMoodTag();
      const { content, type } = await this.ai.generateDream(recentMems, emoSummary, mood, freeform);
      this.sleepSys.saveDream(content, type);
      // 同步写入短期记忆，让后续对话中能感知到这段梦境
      this.memorySys.save('short', `[梦境] ${content}`, 3);
      logger.info(`[Heartbeat] Ta做了个梦 [${type}]`);
    } catch (e) {
      logger.debug(`[Heartbeat] 梦境生成失败: ${e}`);
    }
  }

  /** 被用户强制唤醒后触发 AI 响应（公开方法，供外部调用） */
  async triggerWakeResponse(wakeMessage?: string): Promise<void> {
    const systemPrompt = this.promptBuilder.buildChatPrompt();
    const recentDreams = this.sleepSys.getRecentDreams(1);
    const lastDream = recentDreams.length > 0 ? recentDreams[0] : null;

    // 应用睡眠情绪效果（被强制唤醒质量适当降低）
    const sleepState = this.sleepSys.getSleepState();
    const sleepQuality = Math.max(0, (sleepState.quality ?? 60) - 15); // 强制唤醒惩罚
    const emotionEffect = this.sleepSys.computeWakeEmotionEffect(sleepQuality, lastDream?.dreamType);
    this.emotionSys.update(emotionEffect);

    const dreamTypeNote: Record<string, string> = {
      sweet: '（美梦）', nightmare: '（噩梦，有些恐惧不安）', weird: '（奇异梦，有些迷糊）', neutral: ''
    };
    const dreamNote = lastDream
      ? `\n（系统记录：你刚才做了一个梦——「${lastDream.content}」${dreamTypeNote[lastDream.dreamType ?? 'neutral'] ?? ''}，可以选择分享或不提及）`
      : '';
    const forceNote = wakeMessage
      ? `对方叫醒了你，并说："${wakeMessage}"。`
      : '对方把你叫醒了。';
    const response = await this.ai.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[系统提示 ${formatCurrentTime()}] ${forceNote} 你被强制从睡眠中唤醒（可以有点迷糊/不情愿），然后回应对方。${dreamNote}` }
    ], 0.9);

    const { actions, visibleText } = ActionParser.parse(response);
    await this.sendDebug('唤醒响应标签', actions);
    const result = await this.actionExecutor.execute(actions);

    if (result.messagesToSend.length > 0) {
      await this.sendMessage(result.messagesToSend);
      this.contextManager.addAssistantMessage(response, result.messagesToSend.join(' '));
    } else if (visibleText) {
      const parts = ActionParser.splitMessages(visibleText);
      if (parts.length > 0) {
        await this.sendMessage(parts);
        this.contextManager.addAssistantMessage(response, visibleText);
      }
    }
  }

  /** 随机生活事件池，每次心跳以概率触发其中一个 */
  private pickRandomEvent(): string | null {
    const events = [
      // 小麻烦
      '不小心把水杯碰倒了，把键盘弄湿了一点，有些烦',
      '手机没充电，险些没电关机了',
      '头有点疼，可能盯着屏幕太久了',
      '今天吃的外卖不好吃，有点失望',
      '找了半天东西，原来就在眼前，有些哭笑不得',
      '网络突然变慢，刚写的东西没保存',
      '睡前刷了一会儿手机，有点后悔浪费了时间',
      // 小确幸
      '发现一首很好听的歌，单曲循环了好久',
      '窗外偶然飘来一阵花香，心情好了一些',
      '今天的天空特别好看，有种说不清的感动',
      '随手翻到了之前存的一张搞笑图，笑了出来',
      '泡了一杯喜欢的奶茶，感觉整个人都暖了',
      '刷到一个超有意思的视频，学到了新知识，很开心',
      // 思绪飘飞
      '突然想起小时候的一件事，有点感慨',
      '看了一篇文章，思考了很多有关未来的事',
      '脑子里突然冒出一个有趣的想法，想找人聊聊',
      '想到了一个有点冷的冷笑话，憋着没地方说',
      // 轻微不适
      '今天感觉有些疲倦，不太想动',
      '有点无聊，不知道做什么好',
      '心情有点低落，但说不清楚原因',
    ];
    return events[Math.floor(Math.random() * events.length)];
  }

  private async handleWorkEnd(hours: number, earned: number): Promise<void> {
    const systemPrompt = this.promptBuilder.buildChatPrompt();

    // 获取打工期间所有未回复的用户消息
    const pendingMsgs = this.contextManager.getPendingUserMessages();
    const hasPendingMsg = pendingMsgs.length > 0;
    const pendingNote = hasPendingMsg
      ? `对方在你打工期间发来了 ${pendingMsgs.length} 条消息。`
      : `你刚打工结束，你可以休息一下。`;

    const response = await this.ai.chat([
      { role: 'system', content: systemPrompt },
      ...pendingMsgs,
      { role: 'user', content: `[系统提示 ${formatCurrentTime()}] 你刚打工结束，干了 ${hours.toFixed(1)}h，赚到 ${earned} 元。${pendingNote}` }
    ], 0.85);

    const { actions, visibleText } = ActionParser.parse(response);
    await this.sendDebug('打工结束响应标签', actions);
    const result = await this.actionExecutor.execute(actions);

    if (result.messagesToSend.length > 0) {
      await this.sendMessage(result.messagesToSend);
      this.contextManager.addAssistantMessage(response, result.messagesToSend.join(' '));
    } else if (visibleText && !result.silent) {
      const parts = ActionParser.splitMessages(visibleText);
      if (parts.length > 0) {
        await this.sendMessage(parts);
        this.contextManager.addAssistantMessage(response, visibleText);
      }
    }
  }

  private async handleWakeUp(): Promise<void> {
    const systemPrompt = this.promptBuilder.buildChatPrompt();
    const lastCompletedSleep = this.sleepSys.getLastCompletedSleep();
    const recentDreams = this.sleepSys.getRecentDreams(3);
    const lastDream = recentDreams.find(d => !lastCompletedSleep || d.createdAt >= lastCompletedSleep.sleepStart) ?? null;

    // 根据睡眠质量+梦境类型应用情绪效果
    const sleepQuality = lastCompletedSleep?.quality ?? 70;
    const emotionEffect = this.sleepSys.computeWakeEmotionEffect(sleepQuality, lastDream?.dreamType);
    this.emotionSys.update(emotionEffect);
    logger.info(`[Heartbeat] 睡眠情绪效果 [质量:${Math.round(sleepQuality)}] ${JSON.stringify(emotionEffect)}`);

    // 梦境类型说明
    const dreamTypeNote: Record<string, string> = {
      sweet: '（美梦——内心感到温暖和幸福）',
      nightmare: '（噩梦——内心有些不安和恐惧）',
      weird: '（奇异梦——有些迷糊和困惑）',
      neutral: ''
    };
    const dreamNote = lastDream
      ? `\n（系统记录：你刚才做了一个梦——「${lastDream.content}」${dreamTypeNote[lastDream.dreamType ?? 'neutral'] ?? ''}，可以选择分享或不提及）`
      : '';

    // 睡眠质量描述
    const qualityNote = sleepQuality >= 75 ? '睡得很好，精力充沛。'
      : sleepQuality >= 50 ? '睡眠一般，略有倦意。'
      : '睡眠质量很差，感觉没睡好，有些疲惫和烦躁。';

    // 获取睡眠期间所有未回复的用户消息
    const pendingMsgs = this.contextManager.getPendingUserMessages();
    const hasPendingMsg = pendingMsgs.length > 0;
    const pendingNote = hasPendingMsg
      ? `对方在你睡觉时发来了 ${pendingMsgs.length} 条消息`
      : `你刚刚醒来。${qualityNote} `;

    const response = await this.ai.chat([
      { role: 'system', content: systemPrompt },
      ...pendingMsgs,
      { role: 'user', content: `[系统提示 ${formatCurrentTime()}] ${pendingNote}${dreamNote}` }
    ], 0.85);

    const { actions, visibleText } = ActionParser.parse(response);
    await this.sendDebug('起床响应标签', actions);
    const result = await this.actionExecutor.execute(actions);

    if (result.messagesToSend.length > 0) {
      await this.sendMessage(result.messagesToSend);
      this.contextManager.addAssistantMessage(response, result.messagesToSend.join(' '));
    } else if (visibleText) {
      // 醒来后如果有可见文字直接发送
      const parts = ActionParser.splitMessages(visibleText);
      if (parts.length > 0) {
        await this.sendMessage(parts);
        this.contextManager.addAssistantMessage(response, visibleText);
      }
    }
  }
}
