/**
 * 时间工具函数
 */

/** 格式化当前时间（用于消息显示和提示词） */
export function formatCurrentTime(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 根据消息年龄格式化时间戳（越旧越模糊，近期显示具体时间） */
export function formatTimestamp(ts: number, nowTs?: number): string {
  const now = nowTs ?? Date.now();
  const diff = now - ts;
  const d = new Date(ts);
  const days = Math.floor(diff / 86400000);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  if (days === 0) return hhmm;                                                  // 今天 → 14:30
  if (days === 1) return `昨天 ${hhmm}`;                                        // 昨天 → 昨天 14:30
  if (days < 7) return `${['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]} ${hhmm}`;  // 本周
  if (days < 30) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;        // 本月 → 精确到分
  if (days < 365) return `${d.getMonth() + 1}月${d.getDate()}日`;               // 今年 → 精确到日
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;                            // 更久 → 只到月
}

/** 格式化 Date 对象为 YYYY-MM-DD HH:mm（用于时间标记注入，不模糊处理） */
export function formatFullTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 获取今日日期字符串 YYYY-MM-DD */
export function getTodayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 计算随机延迟（模拟打字时间） */
export function calcTypingDelay(text: string, minMs: number, maxMs: number, charsPerSec: number): number {
  const typingTime = (text.length / charsPerSec) * 1000;
  return Math.min(maxMs, Math.max(minMs, typingTime + Math.random() * 500));
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
