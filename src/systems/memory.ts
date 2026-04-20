import { Database, Memory } from '../database/db';
import { MemoryConfig } from '../config/types';

export type MemoryLevel = 'permanent' | 'long' | 'short';

/**
 * 句子/子句级模糊：按比例随机用 * 替换整个子句，比字符级更可读、更省 token。
 * 句子边界：。！？…\n 和逗号（，,）。
 * ratio=0.35 → 约 1/3 的子句被遮蔽；ratio=0.75 → 约 3/4 被遮蔽。
 * 单句文本在高 ratio 时整体替换为 *。
 */
function blurContent(text: string, ratio: number): string {
  // 按句末标点及逗号切分（保留标点）
  const parts = text.split(/(?<=[。！？…，,\n])/);
  const sentences = parts.map(s => s.trim()).filter(s => s.length > 0);
  if (sentences.length === 0) return text;

  if (sentences.length === 1) {
    return ratio >= 0.5 ? '*' : text;
  }

  // 多子句：随机决定每句是否被遮蔽，但至少保留 1 句
  const blurred: string[] = sentences.map(s => Math.random() < ratio ? '*' : s);
  // 确保至少有 1 子句可见
  if (blurred.every(s => s === '*')) {
    const keepIdx = Math.floor(Math.random() * blurred.length);
    (blurred as string[])[keepIdx] = sentences[keepIdx]!;
  }
  // 合并相邻的 * 为一个
  const merged: string[] = [];
  for (const s of blurred) {
    if (s === '*' && merged[merged.length - 1] === '*') continue;
    merged.push(s);
  }
  return merged.join('');
}

export class MemorySystem {
  constructor(private db: Database, private cfg: MemoryConfig) {}

  /** 保存新记忆（自动去重：若已有高度相似的记忆则更新而非新增） */
  save(level: MemoryLevel, content: string, importance: number): number {
    const trimmed = content.trim();
    // 去重：检查是否存在高度相似的记忆
    const existing = this.db.findSimilarMemory(trimmed, level);
    if (existing && existing.id) {
      // 更新重要度（取较大值）并重置衰减
      const newImportance = Math.max(existing.importance, importance);
      this.db.updateMemory(existing.id, trimmed, newImportance);
      this.db.updateMemoryAccess(existing.id);
      return existing.id;
    }
    return this.db.saveMemory({
      level, content: trimmed, importance,
      createdAt: Date.now(),
      accessedAt: Date.now(),
      accessCount: 0,
      decayFactor: 1.0
    });
  }

  /** 基于关键词检索相关记忆（带相关度评分排序） */
  recall(query: string, limit?: number): Memory[] {
    const maxLimit = limit ?? this.cfg.retrievalLimit;
    const keywords = this.extractKeywords(query);
    let memories: Memory[] = [];

    if (keywords.length > 0) {
      // 多取 3 倍候选，在 JS 侧按相关度重新排序
      const candidates = this.db.searchMemoriesScored(keywords, maxLimit * 3);
      // 相关度评分 = keyword命中比例 * 0.5 + importance*decay * 0.5（两者各半）
      const queryKeySet = new Set(keywords);
      memories = candidates
        .map(m => {
          const contentLower = m.content.toLowerCase();
          const hits = [...queryKeySet].filter(k => contentLower.includes(k.toLowerCase())).length;
          const relevance = (hits / queryKeySet.size) * 0.5 + (m.importance * (m.decayFactor ?? 1)) / 10 * 0.5;
          return { ...m, _score: relevance };
        })
        .sort((a, b) => (b as any)._score - (a as any)._score)
        .slice(0, maxLimit)
        .map(({ _score: _s, ...m }: any) => m as Memory);
    }

    // 不足时补充高重要度永久记忆
    if (memories.length < maxLimit) {
      const perm = this.db.getMemories('permanent').slice(0, 3);
      const existing = new Set(memories.map(m => m.id));
      for (const m of perm) {
        if (!existing.has(m.id) && memories.length < maxLimit) {
          memories.push(m);
          existing.add(m.id);
        }
      }
    }

    // 批量更新访问时间，并对被频繁召回的记忆轻微提升重要度
    const ids = memories.map(m => m.id).filter((id): id is number => id !== undefined);
    this.db.batchUpdateMemoryAccess(ids);
    // 访问次数达到 5+ 且重要度 < 9 的记忆，自动微升重要度
    for (const m of memories) {
      if (m.id !== undefined && (m.accessCount ?? 0) >= 5 && m.importance < 9) {
        this.db.updateMemory(m.id, m.content, Math.min(9, m.importance + 1));
      }
    }

    return memories;
  }

  /** 获取所有永久记忆（用于系统提示词） */
  getPermanentMemories(): Memory[] {
    return this.db.getMemories('permanent');
  }

  /**
   * 按重要度×衰减系数排序，加载 limit 条记忆（全量，不做关键词检索）
   * 永久记忆全部保留；长期/短期按分值排序补足到 limit
   */
  getTopMemories(limit?: number): Memory[] {
    return this._selectMemories(undefined, limit);
  }

  /** 按用户消息关键词对记忆做相关性排序，提升命中条目权重 */
  getRelevantMemories(query: string, limit?: number): Memory[] {
    return this._selectMemories(query, limit);
  }

  private _selectMemories(query: string | undefined, limit?: number): Memory[] {
    const maxLimit = limit ?? this.cfg.retrievalLimit;

    const permanent = this.db.getMemories('permanent');
    const long = this.db.getMemories('long');
    const short = this.db.getMemories('short');

    // 永久记忆全部保留
    const result: Memory[] = [...permanent];
    const seen = new Set(result.map(m => m.id));

    const keywords = query ? query.split(/\s+|[，。！？,.!?]+/).filter(k => k.length >= 2) : [];

    const score = (m: Memory) => {
      const base = m.importance * (m.decayFactor ?? 1);
      if (!keywords.length) return base;
      const hits = keywords.filter(k => m.content.includes(k)).length;
      return base + hits * 1.5;
    };

    // 长期 + 短期 按综合分数排序，取 limit - permanent.length 条
    const remaining = [...long, ...short]
      .filter(m => !seen.has(m.id))
      .sort((a, b) => score(b) - score(a));

    const slots = Math.max(0, maxLimit - result.length);
    result.push(...remaining.slice(0, slots));

    // 更新访问记录
    const ids = result.map(m => m.id).filter((id): id is number => id !== undefined);
    this.db.batchUpdateMemoryAccess(ids);

    return result;
  }

  /** 获取最近的重要长期记忆（心跳时使用，用于补充上下文） */
  getRecentLongTermMemories(limit = 5): Memory[] {
    const mems = this.db.getMemories('long');
    return mems
      .sort((a, b) => (b.importance * (b.decayFactor ?? 1)) - (a.importance * (a.decayFactor ?? 1)))
      .slice(0, limit);
  }

  /** 获取今日短期记忆摘要 */
  getShortTermSummary(): string {
    const mems = this.db.getMemories('short');
    if (!mems.length) return '（今天暂无特别记录）';
    const recent = mems.slice(0, this.cfg.retrievalLimit);
    return recent.map(m => `· ${m.content}`).join('\n');
  }

  /** 更新已有记忆 */
  update(id: number, content: string, importance?: number): boolean {
    return this.db.updateMemory(id, content, importance);
  }

  /** 删除记忆 */
  delete(id: number): void {
    this.db.deleteMemory(id);
  }

  /** 执行记忆衰减（心跳时调用） */
  decay(): void {
    this.db.decayMemories(this.cfg.longTermDecayRatePerDay / 48, this.cfg.importanceThreshold);

    const t1 = this.cfg.blurThreshold1 ?? 0.65;
    const t2 = this.cfg.blurThreshold2 ?? 0.40;
    const t3 = this.cfg.blurThreshold3 ?? 0.20;

    // 第三级模糊：decay_factor < t3 且 blur_level < 3 → 75% 子句遮蔽
    for (const m of this.db.getMemoriesForBlur(t3, 3)) {
      if (m.id !== undefined) {
        this.db.blurMemoryContent(m.id, blurContent(m.content, 0.75), 3);
      }
    }
    // 第二级模糊：decay_factor < t2 且 blur_level < 2 → 50% 子句遮蔽
    for (const m of this.db.getMemoriesForBlur(t2, 2)) {
      if (m.id !== undefined && (m.decayFactor ?? 1) >= t3) {
        this.db.blurMemoryContent(m.id, blurContent(m.content, 0.50), 2);
      }
    }
    // 第一级模糊：decay_factor < t1 且 blur_level < 1 → 20% 子句遮蔽
    for (const m of this.db.getMemoriesForBlur(t1, 1)) {
      if (m.id !== undefined && (m.decayFactor ?? 1) >= t2) {
        this.db.blurMemoryContent(m.id, blurContent(m.content, 0.20), 1);
      }
    }

    // 删除过期梦境记忆
    const dreamTTL = (this.cfg.dreamMemoryTTLHours ?? 48) * 60 * 60 * 1000;
    this.db.deleteDreamMemories(Date.now() - dreamTTL);
  }

  /**
   * 每次对话轮次后调用，对梦境记忆进行渐进式模糊，直到完全遗忘。
   * blur_level: 0→1（35%模糊）, 1→2（50%模糊）, 2→3（75%模糊）, 3→删除
   */
  blurDreamsForTurn(): void {
    const dreams = this.db.getDreamMemories();
    for (const m of dreams) {
      if (!m.id) continue;
      const level = m.blurLevel ?? 0;
      if (level >= 3) {
        this.db.deleteMemory(m.id);
      } else {
        const ratio = level === 0 ? 0.35 : level === 1 ? 0.50 : 0.75;
        this.db.blurMemoryContent(m.id, blurContent(m.content, ratio), level + 1);
      }
    }
  }

  /** 格式化记忆用于提示词（以数据库ID编号，便于AI引用） */
  formatForPrompt(memories: Memory[]): string {
    if (!memories.length) return '（暂无相关记忆）';
    return memories.map(m => `#${m.id} ${m.content}`).join('\n');
  }

  /** 从文本提取关键词（带停用词过滤，侧重实体词） */
  private extractKeywords(text: string): string[] {
    // 中文常见停用词
    const stopWords = new Set(['我','你','他','她','它','们','的','了','在','是','有','和','不','也','都',
      '就','但','这','那','啊','哦','嗯','好','吗','呢','吧','呀','嘛','哈','哇',
      '一个','一些','一直','可以','没有','什么','怎么','为什么','这样','那样',
      '因为','所以','虽然','但是','然后','如果','而且','还有','已经','现在',
      '时候','东西','事情','感觉','觉得','知道','想到','说过','告诉']);

    const cleaned = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
    const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);
    const keywords = new Set<string>();

    for (const token of tokens) {
      if (/[\u4e00-\u9fa5]/.test(token)) {
        // 优先提取 2-4 字词，跳过停用词
        for (let i = 0; i < token.length - 1; i++) {
          const bi = token.slice(i, i + 2);
          const tri = i < token.length - 2 ? token.slice(i, i + 3) : '';
          if (!stopWords.has(bi)) keywords.add(bi);
          if (tri && !stopWords.has(tri)) keywords.add(tri);
        }
        // 整词（≥2字且不是停用词）也加入
        if (token.length >= 2 && !stopWords.has(token)) keywords.add(token);
      } else if (/[a-zA-Z0-9]/.test(token)) {
        keywords.add(token.toLowerCase());
      }
    }
    // 优先保留较长的词（更具区分度）
    return Array.from(keywords)
      .sort((a, b) => b.length - a.length)
      .slice(0, 10);
  }
}
