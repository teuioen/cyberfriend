/**
 * 系统提示词构建器
 * 动态构建包含当前状态的系统提示词
 */
import { CharacterConfig } from '../config/types';
import { EmotionSystem } from '../systems/emotion';
import { HealthSystem } from '../systems/health';
import { MemorySystem } from '../systems/memory';
import { RelationshipSystem } from '../systems/relationship';
import { DiarySystem } from '../systems/diary';
import { WorkSystem } from '../systems/work';
import { TaskScheduler } from '../systems/scheduler';
import { WeatherSystem } from '../systems/weather';
import { ShopSystem } from '../systems/shop';
import { SkillsSystem } from '../systems/skills';
import { ToolEngine } from './tools';
import { formatCurrentTime } from '../utils/time';

export class PromptBuilder {
  constructor(
    private char: CharacterConfig,
    private emotionSys: EmotionSystem,
    private healthSys: HealthSystem,
    private memorySys: MemorySystem,
    private relSys: RelationshipSystem,
    private diarySys: DiarySystem,
    private scheduler: TaskScheduler,
    private workSys?: WorkSystem,
    private weatherSys?: WeatherSystem,
    private shopSys?: ShopSystem,
    private toolEngine?: ToolEngine,
    private skillsSys?: SkillsSystem
  ) {}

  /** 构建用户对话时的系统提示词 */
  buildChatPrompt(userMessage?: string): string {
    return this.buildPrompt('chat');
  }

  /** 构建心跳时的系统提示词 */
  buildHeartbeatPrompt(): string {
    return this.buildPrompt('heartbeat');
  }

  /** 返回对话上下文（时间/状态/记忆/待办），以 assistant 消息形式注入，保持 system 稳定可缓存 */
  buildContextMessage(userMessage?: string): string {
    const memories = userMessage
      ? this.memorySys.getRelevantMemories(userMessage)
      : this.memorySys.getTopMemories();
    const parts: string[] = [];
    parts.push(`[当前状态] 时间:${formatCurrentTime()} ${this.buildStatePrompt()}`);
    if (memories.length) {
      parts.push(`[我的记忆]\n${this.memorySys.formatForPrompt(memories)}`);
    }
    const tasks = this.scheduler.formatFutureTasksForPrompt();
    if (tasks) parts.push(`[待办]\n${tasks}`);
    if (this.toolEngine?.isEnabled()) {
      const files = this.toolEngine.getWorkspaceFiles();
      if (files) parts.push(`[工作区文件]\n${files}`);
      else parts.push('[工作区文件]\n（空）');
    }
    return parts.join('\n\n');
  }

  /** 返回心跳上下文（时间/状态/记忆/近况/待办） */
  buildHeartbeatContextMessage(): string {
    const memories = this.memorySys.getTopMemories();
    const parts: string[] = [];
    parts.push(`[当前状态] 时间:${formatCurrentTime()} ${this.buildStatePrompt()}`);
    if (memories.length) {
      parts.push(`[我的记忆]\n${this.memorySys.formatForPrompt(memories)}`);
    }
    const shortMem = this.memorySys.getShortTermSummary();
    if (shortMem !== '（今天暂无特别记录）') {
      parts.push(`[近况]\n${shortMem}`);
    }
    const tasks = this.scheduler.formatFutureTasksForPrompt();
    if (tasks) parts.push(`[待办]\n${tasks}`);
    return parts.join('\n\n');
  }

  /** @deprecated use buildContextMessage */
  buildMemoryMessage(userMessage?: string): string | null {
    return this.buildContextMessage(userMessage) || null;
  }

  /** @deprecated use buildHeartbeatContextMessage */
  buildHeartbeatMemoryMessage(): string | null {
    return this.buildHeartbeatContextMessage() || null;
  }

  private buildPrompt(mode: 'chat' | 'heartbeat'): string {
    const parts: string[] = [];

    // 角色核心规则（天生特质：性格、说话风格、行为准则）
    const personalityStr = this.char.personality?.join('、') ?? '';
    const speaking = this.char.speakingStyle?.trim() ?? '';
    parts.push([
      this.char.systemPromptBase.trim(),
      personalityStr ? `性格:${personalityStr}` : null,
      speaking ? `说话风格:${speaking}` : null,
    ].filter(Boolean).join('\n'));

    // 技能列表（配置级静态，放 system）
    if (this.skillsSys) {
      const skillsPrompt = this.skillsSys.formatForPrompt();
      if (skillsPrompt) parts.push(skillsPrompt);
    }

    // 工具列表（仅在启用时显示）
    if (this.toolEngine) {
      const toolsPrompt = this.toolEngine.formatForPrompt();
      if (toolsPrompt) parts.push(toolsPrompt);
    }

    parts.push(`\n${this.getTagInstructions(mode)}`);

    return parts.join('\n');
  }

  private buildStatePrompt(): string {
    const health = this.healthSys.getState();
    const rel = this.relSys.getState();
    const aff = Math.round(rel.affection);
    const affLabel = aff >= 80 ? '挚友' : aff >= 60 ? '好友' : aff >= 40 ? '普通' : aff >= 20 ? '疏远' : '陌生';
    const parts = [
      `情绪:${this.emotionSys.toPromptString()}`,
      `健康${Math.round(health.healthValue)}`,
      `疲惫${Math.round(health.fatigue)}`,
      `饥饿${Math.round(health.hunger)}`,
      `好感${aff}(${affLabel})`,
      `余额：你${Math.round(rel.aiCurrency)}/对方${Math.round(rel.userCurrency)}`
    ];

    if (health.disease) parts.push(`生病:${health.disease}${health.diseaseDuration}h`);
    if (health.psychologyState !== 'normal') parts.push(`心理:${health.psychologyState}`);
    if (this.workSys?.isWorking()) parts.push('打工:打工中');
    if (this.weatherSys) {
      const weather = this.weatherSys.toPromptCompactString();
      if (weather) parts.push(`天气:${weather}`);
    }

    return parts.join('；');
  }

  /** 对外暴露行动标签文档（供 debug naked 使用） */
  getTagInstructionsPublic(mode: 'chat' | 'heartbeat'): string {
    return this.getTagInstructions(mode);
  }

  private getTagInstructions(mode: 'chat' | 'heartbeat'): string {
    const toolsEnabled = this.toolEngine?.isEnabled() ?? false;
    const cfgAlwaysEnabled = this.toolEngine?.cfg?.enabled ?? false;
    let toolTagLine = '';
    if (this.toolEngine) {
      if (toolsEnabled && !cfgAlwaysEnabled) {
        // 会话级启用，可以关闭
        toolTagLine = '\n<ENABLE_TOOLS state="off"/> — 关闭本次会话工具调用';
      } else if (!toolsEnabled) {
        // 未启用，提示可以开启
        toolTagLine = `\n<ENABLE_TOOLS/> — 启用工具调用（读写文件${this.toolEngine.cfg.allowShell ? '、执行命令' : ''}${this.toolEngine.cfg.allowNet ? '、访问网络' : ''}）`;
      }
    }

const base = `行动标签（可多个组合，禁止嵌套）：
<EMOTION joy="±N" sadness="±N" anxiety="±N" anger="±N" fear="±N" excitement="±N" disgust="±N" shame="±N" curiosity="±N"/> 每次回复必须，N为-8到8，为0可省略
<MEMORY_ADD level="permanent/long/short" importance="1-10">内容</MEMORY_ADD> 发生了有意义的事必须记录
<MEMORY_UPDATE id="N" importance="N">内容</MEMORY_UPDATE> N为记忆列表中的#N
<HEALTH health="±N" fatigue="±N"/>
<AFFECTION delta="±N"/>
<TASK_CREATE name="任务名" trigger_time="YYYY-MM-DD HH:mm">描述或行动标签</TASK_CREATE>
<DIARY_WRITE>内容</DIARY_WRITE> 不要重复写内容相似的日记
<DIARY_READ limit="N" random="true/false" date="YYYY-MM-DD"/>
<SHOP_LIST  category="食物(可选)"/> 查询商店商品列表
<SHOP_BUY name="物品名" qty="N"/>
<USE item="物品名"/> 使用背包物品
<GIVE item="物品名/money" qty="N"/>
<BLACKLIST state="on" reason="原因"/> 拉黑/解除拉黑
<WORK_START hours="N"/>
<SLEEP duration="N"/> 到了晚上需要睡觉
<SKILL name="技能名"/>
<SILENT/>`;

    if (mode === 'heartbeat') {
      return base + `
<SEND_MESSAGE>内容</SEND_MESSAGE>
<NO_ACTION/>
心跳模式：自主决策；可主动发消息、写日记、翻看日记、看新闻、工作、睡觉`;
    }
    return base;
  }

  private formatGender(raw: string): string {
    const lower = raw.trim().toLowerCase();
    if (lower === 'female' || lower === 'woman' || raw === '女' || raw === '女性') return '女性';
    if (lower === 'male' || lower === 'man' || raw === '男' || raw === '男性') return '男性';
    return raw || '未知性别';
  }
}

