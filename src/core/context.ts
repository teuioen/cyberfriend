/**
 * 上下文管理器
 * 负责构建发送给AI的消息列表，以及触发历史压缩
 */
import { Database, Message } from '../database/db';
import { AIClient, ChatMessage, ToolChatMessage, OpenAIToolCall } from './ai';
import { ContextConfig } from '../config/types';
import { formatTimestamp, formatFullTimestamp } from '../utils/time';
import { logger } from '../utils/logger';

export class ContextManager {
  private compressing = false;  // 防止并发压缩
  onCompressNotify?: (msg: string) => void;  // debug 模式下通知压缩事件

  constructor(
    private db: Database,
    private ai: AIClient,
    private cfg: ContextConfig
  ) {}

  /** 获取最新摘要文本（用于合并进系统提示，避免产生第二个 system 消息） */
  getLatestSummary(): string | null {
    const summaries = this.db.getSummaries();
    return summaries.length > 0 ? summaries[summaries.length - 1].content : null;
  }

  /** 获取对话历史（用于AI调用），异步触发压缩（不阻塞当前请求） */
  async getHistory(): Promise<ToolChatMessage[]> {
    const count = this.db.getMessageCount();
    if (count >= this.cfg.maxMessages && !this.compressing) {
      // 异步压缩，不阻塞当前响应
      this.compressing = true;
      this.compress(0).finally(() => { this.compressing = false; }).catch(e => {
        logger.error(`[Context] 异步压缩失败: ${e}`);
      });
    }
    return this.buildChatHistory();
  }

  /** 添加用户消息到数据库 */
  addUserMessage(content: string): void {
    this.db.saveMessage({
      role: 'user',
      content,
      contentVisible: content,
      timestamp: Date.now()
    });
  }

  /** 删除最后一条用户消息（用于 ESC 中止请求时回滚） */
  removeLastUserMessage(): void {
    const messages = this.db.getMessages();
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.id) {
        this.db.deleteMessage(lastMsg.id);
      }
    }
  }

  /** 添加AI响应到数据库 */
  addAssistantMessage(rawContent: string, visibleContent: string): void {
    this.db.saveMessage({
      role: 'assistant',
      content: rawContent,
      contentVisible: visibleContent,
      timestamp: Date.now()
    });
  }

  /**
   * 保存工具调用交换（intermediate assistant+tool messages）到数据库
   * 每轮工具调用后调用，让下一轮对话知道本轮的工具执行情况
   */
  addToolMessages(toolExchange: ToolChatMessage[]): void {
    const now = Date.now();
    for (const msg of toolExchange) {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolNames = msg.tool_calls.map(tc => tc.function.name).join(', ');
        this.db.saveMessage({
          role: 'assistant',
          content: msg.content ?? '',
          contentVisible: `[调用工具: ${toolNames}]`,
          timestamp: now,
          toolCalls: JSON.stringify(msg.tool_calls),
        });
      } else if (msg.role === 'tool') {
        const preview = msg.content.slice(0, 300);
        this.db.saveMessage({
          role: 'tool',
          content: msg.content,
          contentVisible: `[工具结果] ${preview}${msg.content.length > 300 ? '...' : ''}`,
          timestamp: now,
          toolCallId: msg.tool_call_id,
        });
      }
    }
  }

  /**
   * 获取自上次 AI 回复以来所有未回复的用户消息
   * 用于睡眠/打工结束后检查积压消息，格式化为 ChatMessage 数组
   */
  getPendingUserMessages(): ChatMessage[] {
    const msgs = this.db.getPendingUserMessages();
    return msgs.map(m => ({
      role: 'user' as const,
      content: m.contentVisible || m.content
    }));
  }

  /** 压缩历史记录（累积式：把旧摘要+旧消息合并为单一新摘要，实现自然遗忘） */
  async compress(forceMinMessages = 0): Promise<number> {
    // 获取全部未压缩消息（按时间正序）
    const allUncompressed = this.db.getAllUncompressedMessages();
    // 跳过最前面 compressionKeepFirst 条（永久保留的开头消息）
    const keepFirst = this.cfg.compressionKeepFirst ?? 0;
    const eligible = allUncompressed.slice(keepFirst);
    // forceMinMessages > 0 时可以压缩更多（即使低于 keepRecent 阈值）
    const keepRecent = forceMinMessages > 0
      ? Math.min(this.cfg.compressionKeepRecent, Math.max(0, eligible.length - forceMinMessages))
      : this.cfg.compressionKeepRecent;
    // 保留最近 keepRecent 条
    const toCompress = eligible.slice(0, eligible.length - keepRecent);
    if (toCompress.length < 1) return 0;

    // 获取已有的摘要，一起纳入本次压缩（实现累积/遗忘）
    const existingSummaries = this.db.getSummaries();

    logger.info(`[Context] 压缩 ${toCompress.length} 条历史 + ${existingSummaries.length} 个旧摘要（保留最前${keepFirst}条+最近${keepRecent}条）...`);
    try {
      const chatMsgs: ChatMessage[] = [];
      for (const s of existingSummaries) {
        // 去掉 [对话摘要 ...] 头，避免 AI 在新摘要里回显旧标题
        const sc = s.content.replace(/^\[对话摘要[^\]]*\]\n?/, '').trim();
        chatMsgs.push({ role: 'system', content: `[历史摘要]\n${sc}` });
      }
      const compressRef = Date.now();
      chatMsgs.push(
        ...toCompress
          .filter(m => m.role !== 'system')
          .map(m => {
            const timePrefix = `[${formatTimestamp(m.timestamp, compressRef)}] `;
            // tool 角色映射为 user，assistant(tool_calls) 用可见摘要
            const role: 'user' | 'assistant' = m.role === 'tool' ? 'user' : 'assistant';
            return {
              role: m.role === 'user' ? 'user' as const : role as 'user' | 'assistant',
              content: timePrefix + (m.contentVisible || m.content),
            };
          })
      );

      const summary = await this.ai.compressHistory(chatMsgs);
      // 清理 AI 可能回显的 [对话摘要 ...] 前缀，再套上新的带时间戳的标题
      const cleanSummary = summary.replace(/^\[对话摘要[^\]]*\]\n?/, '').trim();
      const now = new Date();
      const ts = `${now.getFullYear()}/${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getDate().toString().padStart(2,'0')} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
      const summaryMsg = `[对话摘要 ${ts}]\n${cleanSummary}`;
      const summaryIds = existingSummaries.filter(m => m.id !== undefined).map(m => m.id as number);
      const msgIds = toCompress.filter(m => m.id !== undefined).map(m => m.id as number);
      this.db.markSummariesReplaced(summaryIds, msgIds, summaryMsg);
      logger.info(`[Context] 压缩完成，累积摘要已更新`);
      this.onCompressNotify?.(`📦 已压缩 ${toCompress.length} 条历史为摘要`);
      return toCompress.length;
    } catch (err) {
      logger.error(`[Context] 压缩失败: ${err}`);
      return 0;
    }
  }

  /** 手动触发压缩（无论消息数量是否达到阈值） */
  async forceCompress(): Promise<string> {
    if (this.compressing) return '正在压缩中，请稍后';
    const count = this.db.getMessageCount();
    if (count < 2) return `历史记录仅 ${count} 条，无需压缩`;
    this.compressing = true;
    try {
      // 强制压缩：遵守配置的 compressionKeepRecent，保留最近 N 条
      const keepRecent = this.cfg.compressionKeepRecent;
      const forceMin = count > keepRecent ? count - keepRecent : 1;
      const compressed = await this.compress(forceMin);
      if (compressed === 0) return `消息较少（${count} 条），无需压缩`;
      return '';
    } finally {
      this.compressing = false;
    }
  }

  /** 清空所有对话历史（不可恢复） */
  clearHistory(): void {
    this.db.clearMessages();
  }

  /** 删除所有工具调用上下文（role=tool 及含 tool_calls 的 assistant 消息），保留普通对话 */
  clearToolHistory(): number {
    return this.db.deleteToolCallMessages();
  }

  /** 获取带数据库 ID 的历史记录（用于 debug 删除） */
  getHistoryWithIds(): Array<{ id: number; role: string; content: string; contentVisible?: string; timestamp: number }> {
    return this.db.getMessages(this.cfg.maxMessages)
      .filter(m => m.compressed === 0 && m.role !== 'system')
      .map(m => ({
        id: m.id!,
        role: m.role,
        content: m.content,
        contentVisible: m.contentVisible,
        timestamp: m.timestamp,
      }));
  }

  /** 按显示序号（1-based）删除消息 */
  deleteMessageByIndex(index: number): boolean {
    const history = this.getHistoryWithIds();
    const target = history[index - 1];
    if (!target) return false;
    return this.db.deleteMessage(target.id);
  }

  /** 按数据库 ID 删除消息 */
  deleteMessageById(id: number): boolean {
    return this.db.deleteMessage(id);
  }

  /** 构建发送给AI的消息历史（不含摘要，摘要通过 getLatestSummary() 单独提供合并进系统提示） */
  private buildChatHistory(): ToolChatMessage[] {
    const history: ToolChatMessage[] = [];

    // 只取最近 maxMessages 条未压缩消息，纯 user/assistant 交替，不含 system 消息
    // 摘要由调用方通过 getLatestSummary() 合并进系统提示，避免 Qwen 等模型报错
    const messages = this.db.getMessages(this.cfg.maxMessages);
    const gapMs = (this.cfg.timeMarkerIntervalMinutes ?? 5) * 60 * 1000;
    let lastTs = 0;
    let isFirst = true;

    for (const msg of messages) {
      if (msg.compressed !== 0) continue;
      if (msg.role === 'system') continue;  // 跳过旧的系统消息（兼容历史数据）

      // tool 角色消息（工具调用结果）
      if (msg.role === 'tool') {
        history.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId ?? '',
        });
        lastTs = msg.timestamp;
        continue;
      }

      // assistant 含 tool_calls（工具调用请求）
      if (msg.role === 'assistant' && msg.toolCalls) {
        const toolCalls = JSON.parse(msg.toolCalls) as OpenAIToolCall[];
        history.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: toolCalls,
        });
        lastTs = msg.timestamp;
        continue;
      }

      // 普通 user/assistant 消息（含时间前缀注入）
      let raw = msg.role === 'assistant' ? msg.content : (msg.contentVisible || msg.content);

      // 若是第一条消息，或距上条消息超过 gapMs，则将时间前缀注入到消息内容
      // 直接前缀而非插入独立消息，避免连续同角色问题（Qwen 要求 user/assistant 交替）
      if (isFirst || (lastTs > 0 && msg.timestamp - lastTs >= gapMs)) {
        const timeStr = formatFullTimestamp(new Date(msg.timestamp));
        raw = `[${timeStr}]\n${raw}`;
        isFirst = false;
      }
      lastTs = msg.timestamp;

      history.push({ role: msg.role as 'user' | 'assistant', content: raw });
    }

    return history;
  }
}
