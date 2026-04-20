/**
 * Token 计数工具
 * 使用 gpt-tokenizer（cl100k_base / GPT-4 分词器）进行准确计数。
 * Qwen 与 GPT-4 分词器不同，但对中英文混合文本误差通常 <5%，远优于 length/4。
 */
import { encode, encodeChat } from 'gpt-tokenizer';

/**
 * 计算单段文本的 token 数（不含消息 overhead）
 */
export function countTextTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

/**
 * 计算一组 ChatMessage 数组的总 token 数（含角色、分隔符等 overhead）
 * 使用 gpt-4 格式（与 cl100k_base 对齐）
 */
export function countMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  if (!messages.length) return 0;
  try {
    return encodeChat(messages as any, 'gpt-4').length;
  } catch {
    // 降级：手动估算（每条消息 4 token overhead）
    let total = 3;
    for (const m of messages) {
      total += 4 + encode(m.role).length + encode(m.content).length;
    }
    return total;
  }
}
