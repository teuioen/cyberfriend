import { Database, DiaryEntry } from '../database/db';

export class DiarySystem {
  constructor(private db: Database) {}

  /** 保存日记条目 */
  save(content: string, mood?: string): void {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    this.db.saveDiary({ date, content, mood, createdAt: now.getTime() });
  }

  /** 今天是否已写过日记 */
  hasWrittenToday(): boolean {
    const today = new Date().toISOString().split('T')[0];
    const entries = this.db.getDiaries(today, 1);
    return entries.length > 0;
  }

  /** 获取最近一篇日记的写入时间（毫秒时间戳），无日记则返回 0 */
  getLastWriteTime(): number {
    const entries = this.db.getDiaries(undefined, 1, 0);
    return entries.length > 0 ? (entries[0].createdAt ?? 0) : 0;
  }

  /** 今天已写了几篇日记 */
  countToday(): number {
    const today = new Date().toISOString().split('T')[0];
    return this.db.getDiaries(today, 100).length;
  }

  /** 获取指定日期或最近的日记 */
  get(date?: string, limit = 5, offset = 0): DiaryEntry[] {
    return this.db.getDiaries(date, limit, offset);
  }

  /** 搜索日记 */
  search(keyword: string, limit = 10): DiaryEntry[] {
    return this.db.searchDiaries(keyword, limit);
  }

  /** 随机获取几篇日记 */
  getRandom(limit = 3): DiaryEntry[] {
    return this.db.getRandomDiaries(Math.min(limit, 5));
  }

  /** 获取指定页的日记（每页5篇） */
  getPage(page = 1, perPage = 3): { entries: DiaryEntry[]; total: number; page: number; totalPages: number } {
    const total = this.db.getDiaryCount();
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const p = Math.max(1, Math.min(page, totalPages));
    const entries = this.db.getDiaries(undefined, perPage, (p - 1) * perPage);
    return { entries, total, page: p, totalPages };
  }

  /** 格式化日记列表用于显示 */
  formatForDisplay(entries: DiaryEntry[]): string {
    if (!entries.length) return '（还没有写过日记）';
    return entries.map(e => {
      const d = new Date(e.createdAt);
      const timeStr = `${e.date} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      return `📔 [${timeStr}]${e.mood ? ` 心情:${e.mood}` : ''}\n${e.content}`;
    }).join('\n\n---\n\n');
  }

  /** 获取最近日记的简短摘要（用于系统提示词） */
  getRecentSummary(): string {
    const recent = this.get(undefined, 2);
    if (!recent.length) return '';
    return recent.map(e => {
      const d = new Date(e.createdAt);
      const timeStr = `${e.date} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      return `[${timeStr}] ${e.content.slice(0, 50)}...`;
    }).join(' | ');
  }
}
