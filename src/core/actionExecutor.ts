/**
 * 动作执行器
 * 接收解析好的 ParsedAction 列表，调用各系统执行对应逻辑
 */
import { ParsedAction, ActionParser } from './actionParser';
import { EmotionSystem, EmotionDeltas } from '../systems/emotion';
import { HealthSystem } from '../systems/health';
import { MemorySystem, MemoryLevel } from '../systems/memory';
import { RelationshipSystem } from '../systems/relationship';
import { DiarySystem } from '../systems/diary';
import { SleepSystem } from '../systems/sleep';
import { WorkSystem } from '../systems/work';
import { TaskScheduler } from '../systems/scheduler';
import { ShopSystem } from '../systems/shop';
import { Database } from '../database/db';
import { AIClient } from './ai';
import { CharacterConfig } from '../config/types';
import { logger } from '../utils/logger';
import { ToolEngine } from './tools';
import { SkillsSystem } from '../systems/skills';

export interface ExecutionResult {
  messagesToSend: string[];   // 需要发送给用户的消息（来自 SEND_MESSAGE 标签）
  sleepStarted: boolean;
  workStarted: boolean;       // 是否开始打工
  nextHeartbeatMinutes?: number;
  noAction: boolean;
  silent: boolean;            // 不回复用户（来自 SILENT 标签）
  diaryEntries?: string;      // 翻阅日记的内容（用于二次 AI 调用）
  systemMessagesToInject?: string[];  // 工具调用/技能上下文注入
}

import { WeatherSystem } from '../systems/weather';

export class ActionExecutor {
  private showActionSummary = false;

  /** readline 安全打印回调（由 CLI 信道注入，避免输出粘连在输入提示符上） */
  private static safePrint: ((msg: string) => void) | null = null;
  static setSafePrint(fn: (msg: string) => void): void {
    ActionExecutor.safePrint = fn;
  }

  /** 调用 safePrint 打印文本（可从外部调用） */
  static printSafe(msg: string): void {
    if (ActionExecutor.safePrint) ActionExecutor.safePrint(msg);
    else process.stdout.write(msg + '\n');
  }

  constructor(
    private emotionSys: EmotionSystem,
    private healthSys: HealthSystem,
    private memorySys: MemorySystem,
    private relSys: RelationshipSystem,
    private diarySys: DiarySystem,
    private sleepSys: SleepSystem,
    private scheduler: TaskScheduler,
    private ai: AIClient,
    private char: CharacterConfig,
    private shopSys?: ShopSystem,
    private workSys?: WorkSystem,
    private db?: Database,
    private weatherSys?: WeatherSystem,
    private toolEngine?: ToolEngine,
    private skillsSys?: SkillsSystem
  ) {}

  /** 设置是否显示行动摘要 */
  setShowActionSummary(show: boolean): void {
    this.showActionSummary = show;
  }
  /** 记录行动摘要并输出 */
  private logActionSummary(tagName: string, summary: string, rawText?: string): void {
    // 原始标签仅写入文件
    if (rawText) {
      // logger.fileOnly(rawText);
    }
    // 摘要输出到终端 + 日志
    const msg = `✨ ${tagName} → ${summary}`;
    if (this.showActionSummary) {
      // 直接输出到终端（不经过logger），彩色显示
      const YELLOW = '\x1b[33m';
      const CYAN = '\x1b[36m';
      const RESET = '\x1b[0m';
      const colored = `✨ ${YELLOW}${tagName}${RESET} → ${CYAN}${summary}${RESET}`;
      process.stdout.write(colored + '\n');
    } else {
      logger.info(msg);  // 输出到终端 + 日志
    }
  }

  /** 输出彩色的行动摘要到终端（不经过 logger，使用 readline 安全回调避免粘连提示符） */
  private printActionSummary(tagName: string, summary: string): void {
    const YELLOW = '\x1b[33m';
    const CYAN = '\x1b[36m';
    const RESET = '\x1b[0m';
    const msg = `✨ ${YELLOW}${tagName}${RESET} → ${CYAN}${summary}${RESET}`;
    if (ActionExecutor.safePrint) {
      ActionExecutor.safePrint(msg);
    } else {
      process.stdout.write(msg + '\n');
    }
  }

  async execute(actions: ParsedAction[]): Promise<ExecutionResult> {
    const result: ExecutionResult = {
      messagesToSend: [],
      sleepStarted: false,
      workStarted: false,
      nextHeartbeatMinutes: undefined,
      noAction: false,
      silent: false
    };

    for (const action of actions) {
      try {
        await this.executeOne(action, result);
      } catch (err) {
        logger.error(`[Error] 执行标签 ${action.tag} 失败: ${err}`);
      }
    }

    return result;
  }

  private async executeOne(action: ParsedAction, result: ExecutionResult): Promise<void> {
    const { tag, params, content } = action;

    switch (tag) {
      case 'EMOTION': {
        const deltas: EmotionDeltas = {};
        for (const [key, val] of Object.entries(params)) {
          const delta = ActionParser.parseDelta(val);
          if (!isNaN(delta)) (deltas as any)[key] = delta;
        }
        this.emotionSys.update(deltas);
        const deltaStr = Object.entries(deltas).map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`).join(', ');
        this.printActionSummary('情绪', deltaStr);
        break;
      }

      case 'MEMORY_SAVE':
      case 'MEMORY_ADD': {
        if (!content) break;
        const level = (params.level as MemoryLevel) || 'short';
        const importance = parseInt(params.importance ?? '5', 10);
        const clean = ActionParser.stripAll(content);
        this.memorySys.save(level, clean, importance);
        this.printActionSummary('记忆存储', `[${level}] 重要度=${importance}: ${clean.slice(0, 60)}${clean.length > 60 ? '...' : ''}`);
        break;
      }

      case 'MEMORY_UPDATE': {
        if (!content) break;
        const memId = parseInt(params.id ?? '0', 10);
        const importance = params.importance ? parseInt(params.importance, 10) : undefined;
        const clean = ActionParser.stripAll(content);
        const ok = this.memorySys.update(memId, clean, importance);
        if (ok) {
          this.printActionSummary('记忆更新', `[ID=${memId}]${importance ? ` 重要度=${importance}` : ''}: ${clean.slice(0, 60)}${clean.length > 60 ? '...' : ''}`);
        } else {
          logger.warn(`[Error] 记忆更新失败 [ID=${memId}] (记忆不存在)`);
        }
        break;
      }

      case 'MEMORY_DELETE': {
        const memId = parseInt(params.id ?? '0', 10);
        this.memorySys.delete(memId);
        this.printActionSummary('记忆删除', `[ID=${memId}]`);
        break;
      }

      case 'HEALTH': {
        const health = params.health ? ActionParser.parseDelta(params.health) : 0;
        const fatigue = params.fatigue ? ActionParser.parseDelta(params.fatigue) : 0;
        this.healthSys.adjust({ health, fatigue });
        const parts = [];
        if (health) parts.push(`健康:${health > 0 ? '+' : ''}${health}`);
        if (fatigue) parts.push(`疲惫:${fatigue > 0 ? '+' : ''}${fatigue}`);
        if (parts.length) this.printActionSummary('健康', parts.join(', '));
        break;
      }

      case 'AFFECTION': {
        const delta = ActionParser.parseDelta(params.delta ?? '0');
        this.relSys.adjustAffection(delta);
        this.printActionSummary('好感', `${delta > 0 ? '+' : ''}${delta}`);
        break;
      }

      case 'CURRENCY': {
        const owner = (params.owner as 'user' | 'ai') || 'ai';
        const delta = ActionParser.parseDelta(params.delta ?? '0');
        this.relSys.adjustCurrency(owner, delta);
        this.printActionSummary('货币', `[${owner}] ${delta > 0 ? '+' : ''}${delta}`);
        break;
      }

      case 'DISEASE': {
        const key = params.key || 'cold';
        const duration = params.duration ? parseInt(params.duration) : undefined;
        this.healthSys.triggerDisease(key, duration);
        this.printActionSummary('疾病', `${key}${duration ? ` 持续${duration}h` : ''}`);
        break;
      }

      case 'DISEASE_CURE': {
        const name = params.name;
        this.healthSys.cureDisease(name);
        this.printActionSummary('治愈疾病', `${name ?? '全部'}`);
        break;
      }

      case 'DIARY_WRITE': {
        if (!content) break;
        const mood = this.emotionSys.getMoodTag();
        let cleanContent = ActionParser.stripAll(content);
        if (this.weatherSys) {
          const w = this.weatherSys.getWeather();
          if (w && !cleanContent.includes(w.description) && !cleanContent.includes('天气')) {
            const weatherNote = `【${w.city} · ${w.description} ${w.temp}°C】`;
            cleanContent = `${weatherNote}\n${cleanContent}`;
          }
        }
        this.diarySys.save(cleanContent, mood);
        this.printActionSummary('日记写入', `[心情:${mood}] ${cleanContent.slice(0, 80)}${cleanContent.length > 80 ? '...' : ''}`);
        break;
      }

      case 'DIARY_READ': {
        const limit = params.limit ? parseInt(params.limit, 10) : 3;
        const date = params.date;
        const random = params.random === 'true';

        const entries = random
          ? this.diarySys.getRandom(Math.min(limit, 5))
          : this.diarySys.get(date, Math.min(limit, 5));

        if (entries.length > 0) {
          result.diaryEntries = this.diarySys.formatForDisplay(entries);
          this.printActionSummary('翻阅日记', `${entries.length} 篇${random ? '（随机）' : ''}`);
        } else {
          result.diaryEntries = '（还没有写过日记）';
          this.printActionSummary('翻阅日记', '暂无记录');
        }
        break;
      }

      case 'SLEEP': {
        const duration = params.duration ? parseFloat(params.duration) : undefined;
        const health = this.healthSys.getState();
        const emotion = this.emotionSys.getState();
        this.sleepSys.startSleep(duration, health.healthValue, emotion.joy);
        result.sleepStarted = true;
        this.printActionSummary('睡眠', `${duration ?? '随机'}小时`);
        break;
      }

      case 'DREAM': {
        // 梦境由系统在睡眠期间自动生成，此标签为 no-op
        break;
      }

      case 'SEND_MESSAGE': {
        if (!content) break;
        const parts = ActionParser.splitMessages(content);
        result.messagesToSend.push(...parts);
        this.printActionSummary('发送消息', `${parts.length}条`);
        break;
      }

      case 'TASK_CREATE': {
        if (!params.name || !params.trigger_time) break;
        try {
          const rawContent = content ?? '';
          const hasTags = /<[A-Z_]+/.test(rawContent);
          const actionTagsStr = hasTags ? rawContent : undefined;
          const descriptionOnly = (ActionParser.stripAll(rawContent).trim() || undefined);
          this.scheduler.create(params.name, params.trigger_time, descriptionOnly, 'ai', actionTagsStr);
          this.printActionSummary('任务创建', `${params.name} @ ${params.trigger_time}${actionTagsStr ? ' [含行动]' : ''}`);
        } catch (e) {
          logger.warn(`[Error] 任务创建失败: ${e}`);
        }
        break;
      }

      case 'NEXT_HEARTBEAT': {
        const minutes = parseInt(params.minutes ?? '30', 10);
        result.nextHeartbeatMinutes = Math.max(30, minutes);
        this.printActionSummary('心跳间隔', `${result.nextHeartbeatMinutes} 分钟`);
        break;
      }

      case 'NO_ACTION': {
        result.noAction = true;
        this.printActionSummary('无动作', '');
        break;
      }

      case 'SILENT': {
        result.silent = true;
        this.printActionSummary('沉默', '本次不回复');
        break;
      }

      case 'BLACKLIST':
      case 'UNBLACKLIST': {
        if (!this.db) break;
        const stateParam = (params.state ?? (action.tag === 'UNBLACKLIST' ? 'off' : 'on')).toLowerCase();
        const enable = stateParam !== 'off' && stateParam !== 'false' && stateParam !== '0';
        if (enable) {
          const reason = params.reason ?? '不想说话';
          this.db.setBlacklistByAi(true, reason);
          this.printActionSummary('拉黑用户', reason);
        } else {
          this.db.setBlacklistByAi(false);
          this.printActionSummary('解除拉黑', '');
        }
        break;
      }

      case 'SHOP_LIST': {
        if (!this.shopSys) break;
        const tag = params.category ?? params.tag ?? undefined;
        const items = this.shopSys.getItemNames(tag);
        if (!result.systemMessagesToInject) result.systemMessagesToInject = [];
        const label = tag ? `「${tag}」类商品` : '商店商品';
        result.systemMessagesToInject.push(`${label}列表（共${items.length}件）：${items.join('、')}`);
        this.printActionSummary('查询商店', `${items.length} 件商品${tag ? `（${tag}）` : ''}`);
        break;
      }

      case 'SHOP_BUY': {
        if (!params.item && !params.name || !this.shopSys) break;
        const itemName = params.item ?? params.name!;
        const qty = parseInt(params.qty ?? '1', 10);
        const res = this.shopSys.aiBuy(itemName, qty);
        if (res.success) {
          this.printActionSummary('购物', `${itemName} x${qty}`);
        } else {
          logger.warn(`[Error] AI购买失败: ${res.message}`);
        }
        break;
      }

      case 'USE':
      case 'SHOP_USE': {
        if (!params.item || !this.shopSys) break;
        const res = this.shopSys.aiUseItem(params.item);
        if (res.success) {
          this.printActionSummary('使用物品', `${params.item}：${res.message}`);
        }
        break;
      }

      case 'GIVE': {
        // item="money" 或 money="N" 均视为转账
        const isMoneyTransfer = params.money !== undefined || params.item === 'money';
        if (isMoneyTransfer) {
          const amount = parseFloat(params.money ?? params.qty ?? params.amount ?? '0');
          if (amount <= 0) break;
          const state = this.relSys.getState();
          if (state.aiCurrency < amount) {
            logger.warn(`[Error] AI余额不足，无法转账 ${amount}`);
            break;
          }
          this.relSys.adjustCurrency('ai', -amount);
          this.relSys.adjustCurrency('user', amount);
          this.relSys.adjustAffection(0.5);
          this.printActionSummary('赠送金钱', `${amount} 元`);
        } else if (params.item) {
          if (!this.shopSys) break;
          const qty = parseInt(params.qty ?? '1', 10);
          const aiInventoryList = this.shopSys['db'].getInventory('ai') as import('../database/db').InventoryItem[];
          const owned = (aiInventoryList.find(i => i.itemName === params.item)?.quantity) ?? 0;
          if (owned < qty) {
            logger.warn(`[Error] AI赠礼失败：背包中「${params.item}」不足（拥有${owned}，需要${qty}）`);
            break;
          }
          this.shopSys['db'].updateInventory('ai', params.item, -qty);
          this.shopSys['db'].updateInventory('user', params.item, qty);
          this.relSys.adjustAffection(1);
          this.printActionSummary('赠送物品', `${qty} 个「${params.item}」`);
        }
        break;
      }

      case 'WORK_START': {
        if (!this.workSys) break;
        if (this.workSys.isWorking()) break;
        const hours = parseFloat(params.hours ?? '1');
        this.workSys.startWork(hours);
        result.workStarted = true;
        this.printActionSummary('打工', `${hours}小时`);
        break;
      }

      case 'ENABLE_TOOLS': {
        if (!this.toolEngine) break;
        const state = (params.state ?? 'on').toLowerCase();
        if (state === 'off' || state === 'false' || state === '0') {
          this.toolEngine.disableForSession();
          this.printActionSummary('工具', '本次会话已禁用工具调用');
        } else {
          this.toolEngine.enableForSession();
          this.printActionSummary('工具', '本次会话已启用工具调用');
        }
        break;
      }

      case 'SKILL': {
        if (!this.skillsSys) break;
        const skillName = params.name;
        if (!skillName) break;
        const skillResult = this.skillsSys.invoke(skillName);
        if (!skillResult.found) {
          logger.warn(`[Skills] 技能未找到: ${skillName}`);
          break;
        }
        if (skillResult.context) {
          if (!result.systemMessagesToInject) result.systemMessagesToInject = [];
          result.systemMessagesToInject.push(`技能「${skillName}」上下文：\n${skillResult.context}`);
        }
        this.printActionSummary('技能', skillName);
        break;
      }

      default:
        break;
    }
  }
}