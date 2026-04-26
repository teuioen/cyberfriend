import BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

// ===== 类型定义 =====
export interface Message {
  id?: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  contentVisible?: string;
  timestamp: number;
  compressed?: number;
  /** JSON-serialized OpenAIToolCall[] for assistant(tool_calls) messages */
  toolCalls?: string;
  /** tool_call_id for tool role messages */
  toolCallId?: string;
}

export interface Memory {
  id?: number;
  level: 'permanent' | 'long' | 'short';
  content: string;
  importance: number;
  createdAt: number;
  accessedAt?: number;
  accessCount?: number;
  decayFactor?: number;
  blurLevel?: number;
}

export interface EmotionRow {
  joy: number; sadness: number; anxiety: number; anger: number;
  fear: number; excitement: number; disgust: number; shame: number; curiosity: number;
  updatedAt: number;
}

export interface HealthRow {
  healthValue: number; fatigue: number;
  disease: string | null; diseaseDuration: number;
  psychologyState: string; psychologyDuration: number;
  hunger: number;
  updatedAt: number;
}

export interface RelationshipRow {
  affection: number; userCurrency: number; aiCurrency: number; updatedAt: number;
}

export interface DiaryEntry {
  id?: number; date: string; content: string; mood?: string; createdAt: number;
}

export type DreamType = 'sweet' | 'nightmare' | 'weird' | 'neutral';

export interface DreamEntry {
  id?: number; content: string;
  dreamType?: DreamType;
  createdAt: number;
}

export interface SleepRow {
  isSleeping: number; sleepStart: number | null;
  wakeTime: number | null; durationHours: number | null; quality: number | null;
}

export interface WorkRow {
  isWorking: number; workStart: number | null;
  endTime: number | null; durationHours: number | null; earningRate: number | null;
}

export interface UserWorkRow {
  isWorking: number; workStart: number | null;
  endTime: number | null; durationHours: number | null; earningRate: number | null;
}

export interface BlacklistRow {
  blacklistedByAi: number;   // 1 = AI拉黑了用户
  blacklistedByUser: number; // 1 = 用户屏蔽了AI主动消息
  reasonByAi: string | null;
}

export interface Task {
  id?: number; name: string; description?: string;
  triggerTime: number; createdBy: string; executed?: number; createdAt?: number;
  actionTags?: string;  // 任务触发时自动执行的行动标签（原始文本）
}

export interface InventoryItem {
  id?: number; owner: string; itemName: string; quantity: number;
}

export interface NewsItem {
  id?: number; title: string; source: string; url?: string;
  summary?: string; fetchedAt: number; sharedAt?: number | null;
}

export interface ApiUsageEntry {
  id?: number;
  endpoint: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: number;
}

export interface ApiUsageSummary {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ApiUsageByModel extends ApiUsageSummary {
  endpoint: string;
  model: string;
}

export interface DatabaseBootstrapConfig {
  initialAffection?: number;
  healthDefaults?: Partial<Pick<HealthRow, 'healthValue' | 'fatigue'>>;
  emotionDefaults?: Partial<Omit<EmotionRow, 'updatedAt'>>;
}

// ===== 数据库类 =====
export class Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string, private bootstrapConfig?: DatabaseBootstrapConfig) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_visible TEXT,
        timestamp INTEGER NOT NULL,
        compressed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_compressed ON messages(compressed);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER DEFAULT 5,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER,
        access_count INTEGER DEFAULT 0,
        decay_factor REAL DEFAULT 1.0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_level ON memories(level);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);

      CREATE TABLE IF NOT EXISTS emotions (
        id INTEGER PRIMARY KEY DEFAULT 1,
        joy REAL DEFAULT 50, sadness REAL DEFAULT 20,
        anxiety REAL DEFAULT 20, anger REAL DEFAULT 10,
        fear REAL DEFAULT 10, excitement REAL DEFAULT 30,
        disgust REAL DEFAULT 10, shame REAL DEFAULT 10, curiosity REAL DEFAULT 40,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS health (
        id INTEGER PRIMARY KEY DEFAULT 1,
        health_value REAL DEFAULT 100, fatigue REAL DEFAULT 0,
        disease TEXT, disease_duration INTEGER DEFAULT 0,
        psychology_state TEXT DEFAULT 'normal', psychology_duration INTEGER DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationship (
        id INTEGER PRIMARY KEY DEFAULT 1,
        affection REAL DEFAULT 40, user_currency REAL DEFAULT 0,
        ai_currency REAL DEFAULT 0, updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL, content TEXT NOT NULL,
        mood TEXT, created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL, created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sleep_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        is_sleeping INTEGER DEFAULT 0,
        sleep_start INTEGER, wake_time INTEGER,
        duration_hours REAL, quality REAL
      );

      CREATE TABLE IF NOT EXISTS work_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        is_working INTEGER DEFAULT 0,
        work_start INTEGER, end_time INTEGER,
        duration_hours REAL, earning_rate REAL
      );

      CREATE TABLE IF NOT EXISTS user_work_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        is_working INTEGER DEFAULT 0,
        work_start INTEGER, end_time INTEGER,
        duration_hours REAL, earning_rate REAL
      );

      CREATE TABLE IF NOT EXISTS blacklist (
        id INTEGER PRIMARY KEY DEFAULT 1,
        blacklisted_by_ai INTEGER DEFAULT 0,
        blacklisted_by_user INTEGER DEFAULT 0,
        reason_by_ai TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, description TEXT,
        trigger_time INTEGER NOT NULL, created_by TEXT DEFAULT 'ai',
        executed INTEGER DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_pending ON tasks(executed, trigger_time);

      CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL, item_name TEXT NOT NULL, quantity INTEGER DEFAULT 0,
        UNIQUE(owner, item_name)
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_owner ON inventory(owner);

      CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, source TEXT NOT NULL,
        url TEXT UNIQUE, summary TEXT,
        fetched_at INTEGER NOT NULL, shared_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_news_unshared ON news(shared_at, fetched_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_api_usage_model ON api_usage(model, created_at DESC);
    `);
    this.runMigrations();
    this.ensureDefaultRows();
  }

  private runMigrations(): void {
    // 迁移：为 news.url 加唯一索引，避免重复
    try {
      const idx = this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_news_url'`
      ).get();
      if (!idx) {
        // 删除重复 URL（保留最新的）
        this.db.exec(`
          DELETE FROM news WHERE id NOT IN (
            SELECT MAX(id) FROM news GROUP BY url
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_news_url ON news(url);
        `);
      }
    } catch {
      // 忽略迁移错误
    }
    // 迁移：dreams 表添加 dream_type 列
    try {
      const cols = this.db.prepare(`PRAGMA table_info(dreams)`).all() as any[];
      const hasDreamType = cols.some(c => c.name === 'dream_type');
      if (!hasDreamType) {
        this.db.exec(`ALTER TABLE dreams ADD COLUMN dream_type TEXT DEFAULT 'neutral'`);
      }
    } catch {
      // 忽略迁移错误
    }

    // 检查是否需要添加 curiosity 列到 emotions 表
    try {
      const cols = this.db.prepare(`PRAGMA table_info(emotions)`).all() as any[];
      const hasCuriosity = cols.some(c => c.name === 'curiosity');
      if (!hasCuriosity) {
        this.db.exec(`ALTER TABLE emotions ADD COLUMN curiosity REAL DEFAULT 40`);
      }
    } catch {
      // 忽略迁移错误
    }

    // 迁移：tasks 表添加 action_tags 列
    try {
      const cols = this.db.prepare(`PRAGMA table_info(tasks)`).all() as any[];
      const hasActionTags = cols.some(c => c.name === 'action_tags');
      if (!hasActionTags) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN action_tags TEXT`);
      }
    } catch {
      // 忽略迁移错误
    }

    // 迁移：memories 表添加 blur_level 列
    try {
      const cols = this.db.prepare(`PRAGMA table_info(memories)`).all() as any[];
      const hasBlurLevel = cols.some(c => c.name === 'blur_level');
      if (!hasBlurLevel) {
        this.db.exec(`ALTER TABLE memories ADD COLUMN blur_level INTEGER DEFAULT 0`);
      }
    } catch {
      // 忽略迁移错误
    }

    // 迁移：health 表添加 hunger 列
    try { this.db.exec("ALTER TABLE health ADD COLUMN hunger REAL NOT NULL DEFAULT 80"); } catch {}

    // 迁移：messages 表添加 tool_calls 和 tool_call_id 列
    try {
      const msgCols = this.db.prepare(`PRAGMA table_info(messages)`).all() as any[];
      if (!msgCols.some(c => c.name === 'tool_calls')) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN tool_calls TEXT`);
      }
      if (!msgCols.some(c => c.name === 'tool_call_id')) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
      }
    } catch {
      // 忽略迁移错误
    }
  }

  private ensureDefaultRows(): void {
    const now = Date.now();
    const emo = this.db.prepare('SELECT id FROM emotions WHERE id=1').get();
    if (!emo) {
      const emotions = this.getBootstrapEmotionDefaults();
      this.db.prepare(`
        INSERT INTO emotions(
          id, joy, sadness, anxiety, anger, fear, excitement, disgust, shame, curiosity, updated_at
        ) VALUES(1,?,?,?,?,?,?,?,?,?,?)
      `).run(
        emotions.joy,
        emotions.sadness,
        emotions.anxiety,
        emotions.anger,
        emotions.fear,
        emotions.excitement,
        emotions.disgust,
        emotions.shame,
        emotions.curiosity,
        now
      );
    }

    const health = this.db.prepare('SELECT id FROM health WHERE id=1').get();
    if (!health) {
      const healthDefaults = this.getBootstrapHealthDefaults();
      this.db.prepare('INSERT INTO health(id,health_value,fatigue,updated_at) VALUES(1,?,?,?)').run(
        healthDefaults.healthValue,
        healthDefaults.fatigue,
        now
      );
    }

    const rel = this.db.prepare('SELECT id FROM relationship WHERE id=1').get();
    if (!rel) {
      const initialAffection = this.bootstrapConfig?.initialAffection ?? 40;
      this.db.prepare('INSERT INTO relationship(id,affection,updated_at) VALUES(1,?,?)').run(initialAffection, now);
    }

    const sleep = this.db.prepare('SELECT id FROM sleep_state WHERE id=1').get();
    if (!sleep) this.db.prepare('INSERT INTO sleep_state(id) VALUES(1)').run();

    const work = this.db.prepare('SELECT id FROM work_state WHERE id=1').get();
    if (!work) this.db.prepare('INSERT INTO work_state(id) VALUES(1)').run();

    const userWork = this.db.prepare('SELECT id FROM user_work_state WHERE id=1').get();
    if (!userWork) this.db.prepare('INSERT INTO user_work_state(id) VALUES(1)').run();

    const bl = this.db.prepare('SELECT id FROM blacklist WHERE id=1').get();
    if (!bl) this.db.prepare('INSERT INTO blacklist(id) VALUES(1)').run();

    this.applyBootstrapDefaultsIfPristine();
  }

  private getBootstrapEmotionDefaults(): Omit<EmotionRow, 'updatedAt'> {
    return {
      joy: this.bootstrapConfig?.emotionDefaults?.joy ?? 50,
      sadness: this.bootstrapConfig?.emotionDefaults?.sadness ?? 20,
      anxiety: this.bootstrapConfig?.emotionDefaults?.anxiety ?? 20,
      anger: this.bootstrapConfig?.emotionDefaults?.anger ?? 10,
      fear: this.bootstrapConfig?.emotionDefaults?.fear ?? 10,
      excitement: this.bootstrapConfig?.emotionDefaults?.excitement ?? 30,
      disgust: this.bootstrapConfig?.emotionDefaults?.disgust ?? 10,
      shame: this.bootstrapConfig?.emotionDefaults?.shame ?? 10,
      curiosity: this.bootstrapConfig?.emotionDefaults?.curiosity ?? 40,
    };
  }

  private getBootstrapHealthDefaults(): Pick<HealthRow, 'healthValue' | 'fatigue'> {
    return {
      healthValue: this.bootstrapConfig?.healthDefaults?.healthValue ?? 100,
      fatigue: this.bootstrapConfig?.healthDefaults?.fatigue ?? 0,
    };
  }

  private applyBootstrapDefaultsIfPristine(): void {
    if (!this.bootstrapConfig) return;
    if (this.getSetting('bootstrap_defaults_applied') === '1') return;
    if (this.getMessageCount() > 0) {
      this.setSetting('bootstrap_defaults_applied', '1');
      return;
    }

    const currentEmotion = this.getEmotions();
    if (this.isLegacyEmotionDefaults(currentEmotion)) {
      this.updateEmotions(this.getBootstrapEmotionDefaults());
    }

    const currentHealth = this.getHealth();
    if (this.isLegacyHealthDefaults(currentHealth)) {
      this.updateHealth(this.getBootstrapHealthDefaults());
    }

    if (this.bootstrapConfig.initialAffection !== undefined) {
      const currentRelationship = this.getRelationship();
      if (currentRelationship.affection === 40) {
        this.updateRelationship({ affection: this.bootstrapConfig.initialAffection });
      }
    }

    this.setSetting('bootstrap_defaults_applied', '1');
  }

  private isLegacyEmotionDefaults(current: EmotionRow): boolean {
    return current.joy === 50
      && current.sadness === 20
      && current.anxiety === 20
      && current.anger === 10
      && current.fear === 10
      && current.excitement === 30
      && current.disgust === 10
      && current.shame === 10
      && current.curiosity === 40;
  }

  private isLegacyHealthDefaults(current: HealthRow): boolean {
    return current.healthValue === 100
      && current.fatigue === 0
      && !current.disease
      && current.diseaseDuration === 0
      && current.psychologyState === 'normal'
      && current.psychologyDuration === 0;
  }

  // ===== 消息操作 =====
  saveMessage(msg: Message): number {
    const r = this.db.prepare(
      `INSERT INTO messages(role,content,content_visible,timestamp,compressed,tool_calls,tool_call_id)
       VALUES(?,?,?,?,?,?,?)`
    ).run(
      msg.role,
      msg.content,
      msg.contentVisible ?? msg.content,
      msg.timestamp,
      msg.compressed ?? 0,
      msg.toolCalls ?? null,
      msg.toolCallId ?? null
    );
    return Number(r.lastInsertRowid);
  }

  getMessages(limit = 50, excludeCompressed = false): Message[] {
    const where = excludeCompressed ? 'WHERE compressed=0' : '';
    const rows = this.db.prepare(
      `SELECT id,role,content,content_visible,timestamp,compressed,tool_calls,tool_call_id FROM messages ${where} ORDER BY id DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.reverse().map(r => ({
      id: r.id, role: r.role, content: r.content,
      contentVisible: r.content_visible, timestamp: r.timestamp, compressed: r.compressed,
      toolCalls: r.tool_calls, toolCallId: r.tool_call_id
    }));
  }

  /** 获取全部未压缩消息（按时间正序），用于压缩逻辑 */
  getAllUncompressedMessages(): Message[] {
    const rows = this.db.prepare(
      `SELECT id,role,content,content_visible,timestamp,tool_calls,tool_call_id FROM messages WHERE compressed=0 ORDER BY timestamp ASC`
    ).all() as any[];
    return rows.map(r => ({
      id: r.id, role: r.role, content: r.content,
      contentVisible: r.content_visible, timestamp: r.timestamp,
      toolCalls: r.tool_calls, toolCallId: r.tool_call_id
    }));
  }

  /**
   * 获取自上次 AI 回复以来所有未回复的用户消息（按时间正序）
   * 用于睡眠/打工结束后检查积压消息
   */
  getPendingUserMessages(): Message[] {
    // 找到最后一条 assistant 消息的时间
    const lastAi = this.db.prepare(
      `SELECT timestamp FROM messages WHERE role='assistant' AND compressed=0 ORDER BY timestamp DESC LIMIT 1`
    ).get() as { timestamp: number } | undefined;
    const since = lastAi?.timestamp ?? 0;
    const rows = this.db.prepare(
      `SELECT id,role,content,content_visible,timestamp,compressed FROM messages WHERE role='user' AND timestamp>? AND compressed=0 ORDER BY timestamp ASC`
    ).all(since) as any[];
    return rows.map(r => ({
      id: r.id, role: r.role, content: r.content,
      contentVisible: r.content_visible, timestamp: r.timestamp, compressed: r.compressed
    }));
  }

  markMessagesCompressed(ids: number[], summaryContent: string): void {
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        this.db.prepare('UPDATE messages SET compressed=1 WHERE id=?').run(id);
      }
      this.db.prepare(
        `INSERT INTO messages(role,content,content_visible,timestamp,compressed) VALUES(?,?,?,?,?)`
      ).run('system', summaryContent, summaryContent, Date.now(), 2);
    });
    tx();
  }

  getMessageCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE compressed=0').get() as any;
    return r.cnt;
  }

  /** 获取所有已有的压缩摘要（compressed=2） */
  getSummaries(): Message[] {
    const rows = this.db.prepare(
      `SELECT id,role,content,content_visible,timestamp,compressed FROM messages WHERE compressed=2 ORDER BY timestamp ASC`
    ).all() as any[];
    return rows.map(r => ({
      id: r.id, role: r.role, content: r.content,
      contentVisible: r.content_visible, timestamp: r.timestamp, compressed: r.compressed
    }));
  }

  /** 合并替换旧摘要：将旧摘要IDs + 旧消息IDs标记为compressed=1，再插入新摘要 */
  markSummariesReplaced(summaryIds: number[], messageIds: number[], newSummaryContent: string): void {
    const tx = this.db.transaction(() => {
      for (const id of [...summaryIds, ...messageIds]) {
        this.db.prepare('UPDATE messages SET compressed=1 WHERE id=?').run(id);
      }
      this.db.prepare(
        `INSERT INTO messages(role,content,content_visible,timestamp,compressed) VALUES(?,?,?,?,?)`
      ).run('system', newSummaryContent, newSummaryContent, Date.now(), 2);
    });
    tx();
  }

  clearMessages(): void {
    this.db.prepare('DELETE FROM messages').run();
  }

  deleteMessage(id: number): boolean {
    const r = this.db.prepare('DELETE FROM messages WHERE id=?').run(id);
    return r.changes > 0;
  }

  /** 删除所有工具调用相关消息（role='tool' 及含 tool_calls 的 assistant 消息） */
  deleteToolCallMessages(): number {
    const r1 = this.db.prepare(`DELETE FROM messages WHERE role='tool'`).run();
    const r2 = this.db.prepare(`DELETE FROM messages WHERE role='assistant' AND tool_calls IS NOT NULL`).run();
    return r1.changes + r2.changes;
  }

  // ===== 记忆操作 =====
  /** 查找内容高度相似的记忆（用于去重，支持字符重叠检测） */
  findSimilarMemory(content: string, level: string): Memory | undefined {
    const rows = this.db.prepare('SELECT * FROM memories WHERE level=? ORDER BY created_at DESC LIMIT 50').all(level) as any[];
    const target = content.trim().toLowerCase();
    const targetShort = target.slice(0, 60);
    for (const row of rows) {
      const existing = (row.content as string).trim().toLowerCase();
      const existingShort = existing.slice(0, 60);
      // 精确匹配或前缀匹配
      if (existing === target || (target.length > 10 && existingShort.startsWith(targetShort.slice(0, Math.min(30, targetShort.length))))) {
        return this.rowToMemory(row);
      }
      // 字符集重叠度 > 70%（防止同义重复）
      if (target.length >= 8 && existing.length >= 8) {
        const tChars = new Set(target.replace(/\s/g, ''));
        const eChars = new Set(existing.replace(/\s/g, ''));
        let overlap = 0;
        for (const c of tChars) { if (eChars.has(c)) overlap++; }
        const overlapRate = overlap / Math.max(tChars.size, eChars.size);
        // 同时要求长度相近（防止短词误判长句）
        const lenRatio = Math.min(target.length, existing.length) / Math.max(target.length, existing.length);
        if (overlapRate > 0.75 && lenRatio > 0.6) {
          return this.rowToMemory(row);
        }
      }
    }
    return undefined;
  }

  saveMemory(memory: Memory): number {
    const r = this.db.prepare(
      `INSERT INTO memories(level,content,importance,created_at,accessed_at,access_count,decay_factor,blur_level)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(
      memory.level, memory.content, memory.importance,
      memory.createdAt, memory.accessedAt ?? memory.createdAt,
      memory.accessCount ?? 0, memory.decayFactor ?? 1.0,
      memory.blurLevel ?? 0
    );
    return Number(r.lastInsertRowid);
  }

  getMemories(level?: string): Memory[] {
    const rows = level
      ? this.db.prepare('SELECT * FROM memories WHERE level=? ORDER BY id ASC').all(level) as any[]
      : this.db.prepare('SELECT * FROM memories ORDER BY id ASC').all() as any[];
    return rows.map(this.rowToMemory);
  }

  searchMemories(keywords: string[], limit = 6): Memory[] {
    if (!keywords.length) return [];
    const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
    const params = keywords.map(k => `%${k}%`);
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE ${conditions} ORDER BY (importance * decay_factor) DESC LIMIT ?`
    ).all(...params, limit) as any[];
    return rows.map(this.rowToMemory);
  }

  /** 搜索记忆并返回更多候选（供上层相关度重排序使用） */
  searchMemoriesScored(keywords: string[], limit = 18): Memory[] {
    if (!keywords.length) return [];
    const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
    const params = keywords.map(k => `%${k}%`);
    // 加入 recency 权重：最近访问的适当提升
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE ${conditions}
       ORDER BY (importance * decay_factor * (1 + 0.1 * MIN(access_count, 5))) DESC LIMIT ?`
    ).all(...params, limit) as any[];
    return rows.map(this.rowToMemory);
  }

  updateMemoryAccess(id: number): void {
    this.db.prepare(
      'UPDATE memories SET accessed_at=?, access_count=access_count+1 WHERE id=?'
    ).run(Date.now(), id);
  }

  /** 批量更新记忆访问时间（避免 N 次独立查询） */
  batchUpdateMemoryAccess(ids: number[]): void {
    if (!ids.length) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      'UPDATE memories SET accessed_at=?, access_count=access_count+1 WHERE id=?'
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    });
    tx();
  }

  /** 更新记忆内容 */
  updateMemory(id: number, content: string, importance?: number): boolean {
    const existing = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as any;
    if (!existing) return false;
    this.db.prepare(
      'UPDATE memories SET content=?, importance=?, accessed_at=? WHERE id=?'
    ).run(content, importance ?? existing.importance, Date.now(), id);
    return true;
  }

  /** 删除记忆 */
  deleteMemory(id: number): void {
    this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
  }

  clearMemories(levels?: string[]): void {
    if (!levels || levels.length === 0) {
      this.db.prepare('DELETE FROM memories').run();
      return;
    }
    const placeholders = levels.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM memories WHERE level IN (${placeholders})`).run(...levels);
  }

  /** 更新记忆内容（用于模糊处理） */
  blurMemoryContent(id: number, newContent: string, blurLevel: number): void {
    this.db.prepare(
      'UPDATE memories SET content=?, blur_level=? WHERE id=?'
    ).run(newContent, blurLevel, id);
  }

  /** 获取需要模糊处理的非永久记忆（按衰减因子筛选，已到某级别阈值但尚未达到该级别） */
  getMemoriesForBlur(threshold: number, maxBlurLevel: number): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE level IN (?,?) AND decay_factor < ? AND blur_level < ?`
    ).all('long', 'short', threshold, maxBlurLevel) as any[];
    return rows.map(r => this.rowToMemory(r));
  }

  /** 删除指定TTL时间前创建的梦境短期记忆 */
  deleteDreamMemories(beforeTimestamp: number): void {
    this.db.prepare(
      `DELETE FROM memories WHERE level='short' AND content LIKE '%[梦境]%' AND created_at < ?`
    ).run(beforeTimestamp);
  }

  /** 获取所有梦境短期记忆（用于对话轮次模糊处理） */
  getDreamMemories(): Memory[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE level='short' AND content LIKE '%[梦境]%'`
    ).all() as any[];
    return rows.map(r => this.rowToMemory(r));
  }

  decayMemories(decayRate: number, threshold: number): void {
    this.db.prepare(
      'UPDATE memories SET decay_factor=decay_factor*(1-?) WHERE level IN (?,?)'
    ).run(decayRate, 'long', 'short');
    // 删除有效重要度低于阈值的短期/长期记忆
    this.db.prepare(
      'DELETE FROM memories WHERE level IN (?,?) AND (importance * decay_factor) < ?'
    ).run('long', 'short', threshold);
    // 删除过期短期记忆（7天）
    const cutoff = Date.now() - 24 * 60 * 60 * 1000 * 7;
    this.db.prepare('DELETE FROM memories WHERE level=? AND created_at<?').run('short', cutoff);
  }

  private rowToMemory(r: any): Memory {
    return {
      id: r.id, level: r.level, content: r.content, importance: r.importance,
      createdAt: r.created_at, accessedAt: r.accessed_at,
      accessCount: r.access_count, decayFactor: r.decay_factor,
      blurLevel: r.blur_level ?? 0
    };
  }

  // ===== 情绪操作 =====
  getEmotions(): EmotionRow {
    const r = this.db.prepare('SELECT * FROM emotions WHERE id=1').get() as any;
    return {
      joy: r.joy, sadness: r.sadness, anxiety: r.anxiety, anger: r.anger,
      fear: r.fear, excitement: r.excitement, disgust: r.disgust, shame: r.shame,
      curiosity: r.curiosity ?? 40,  // 默认值（兼容旧数据库）
      updatedAt: r.updated_at
    };
  }

  updateEmotions(e: Partial<EmotionRow>): void {
    const fields = Object.entries(e)
      .filter(([k]) => k !== 'updatedAt')
      .map(([k]) => `${this.camelToSnake(k)}=?`)
      .join(',');
    const vals = Object.entries(e).filter(([k]) => k !== 'updatedAt').map(([, v]) => v);
    if (!fields) return;
    this.db.prepare(`UPDATE emotions SET ${fields}, updated_at=? WHERE id=1`).run(...vals, Date.now());
  }

  // ===== 健康操作 =====
  getHealth(): HealthRow {
    const r = this.db.prepare('SELECT * FROM health WHERE id=1').get() as any;
    return {
      healthValue: r.health_value, fatigue: r.fatigue,
      disease: r.disease, diseaseDuration: r.disease_duration,
      psychologyState: r.psychology_state, psychologyDuration: r.psychology_duration,
      hunger: r.hunger ?? 80,
      updatedAt: r.updated_at
    };
  }

  updateHealth(h: Partial<HealthRow>): void {
    const map: Record<string, string> = {
      healthValue: 'health_value', fatigue: 'fatigue',
      disease: 'disease', diseaseDuration: 'disease_duration',
      psychologyState: 'psychology_state', psychologyDuration: 'psychology_duration',
      hunger: 'hunger'
    };
    const entries = Object.entries(h).filter(([k]) => k !== 'updatedAt' && map[k]);
    if (!entries.length) return;
    const fields = entries.map(([k]) => `${map[k]}=?`).join(',');
    const vals = entries.map(([, v]) => v);
    this.db.prepare(`UPDATE health SET ${fields}, updated_at=? WHERE id=1`).run(...vals, Date.now());
  }

  // ===== 关系操作 =====
  getRelationship(): RelationshipRow {
    const r = this.db.prepare('SELECT * FROM relationship WHERE id=1').get() as any;
    return {
      affection: r.affection, userCurrency: r.user_currency,
      aiCurrency: r.ai_currency, updatedAt: r.updated_at
    };
  }

  updateRelationship(rel: Partial<RelationshipRow>): void {
    const map: Record<string, string> = {
      affection: 'affection', userCurrency: 'user_currency', aiCurrency: 'ai_currency'
    };
    const entries = Object.entries(rel).filter(([k]) => k !== 'updatedAt' && map[k]);
    if (!entries.length) return;
    const fields = entries.map(([k]) => `${map[k]}=?`).join(',');
    const vals = entries.map(([, v]) => v);
    this.db.prepare(`UPDATE relationship SET ${fields}, updated_at=? WHERE id=1`).run(...vals, Date.now());
  }

  // ===== 日记操作 =====
  saveDiary(entry: DiaryEntry): void {
    this.db.prepare(
      'INSERT INTO diary(date,content,mood,created_at) VALUES(?,?,?,?)'
    ).run(entry.date, entry.content, entry.mood ?? null, entry.createdAt);
  }

  getDiaries(date?: string, limit = 10, offset = 0): DiaryEntry[] {
    const rows = date
      ? this.db.prepare('SELECT * FROM diary WHERE date=? ORDER BY created_at DESC').all(date) as any[]
      : this.db.prepare('SELECT * FROM diary ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as any[];
    return rows.map(r => ({ id: r.id, date: r.date, content: r.content, mood: r.mood, createdAt: r.created_at }));
  }

  /** 全文搜索日记 */
  searchDiaries(keyword: string, limit = 10): DiaryEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM diary WHERE content LIKE ? OR mood LIKE ? ORDER BY created_at DESC LIMIT ?`
    ).all(`%${keyword}%`, `%${keyword}%`, limit) as any[];
    return rows.map(r => ({ id: r.id, date: r.date, content: r.content, mood: r.mood, createdAt: r.created_at }));
  }

  getDiaryCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) as cnt FROM diary').get() as any;
    return r.cnt;
  }

  /** 随机获取日记 */
  getRandomDiaries(limit = 3): DiaryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM diary ORDER BY RANDOM() LIMIT ?'
    ).all(limit) as any[];
    return rows.map(r => ({ id: r.id, date: r.date, content: r.content, mood: r.mood, createdAt: r.created_at }));
  }

  // ===== 梦境操作 =====
  saveDream(dream: DreamEntry): void {
    this.db.prepare('INSERT INTO dreams(content,dream_type,created_at) VALUES(?,?,?)').run(dream.content, dream.dreamType ?? 'neutral', dream.createdAt);
  }

  getRecentDreams(limit = 3): DreamEntry[] {
    const rows = this.db.prepare('SELECT * FROM dreams ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
    return rows.map(r => ({ id: r.id, content: r.content, dreamType: r.dream_type as DreamType | undefined, createdAt: r.created_at }));
  }

  // ===== 睡眠操作 =====
  getSleepState(): SleepRow {
    const r = this.db.prepare('SELECT * FROM sleep_state WHERE id=1').get() as any;
    return {
      isSleeping: r.is_sleeping, sleepStart: r.sleep_start,
      wakeTime: r.wake_time, durationHours: r.duration_hours, quality: r.quality
    };
  }

  updateSleepState(s: Partial<SleepRow>): void {
    const map: Record<string, string> = {
      isSleeping: 'is_sleeping', sleepStart: 'sleep_start',
      wakeTime: 'wake_time', durationHours: 'duration_hours', quality: 'quality'
    };
    const entries = Object.entries(s).filter(([k]) => map[k]);
    if (!entries.length) return;
    const fields = entries.map(([k]) => `${map[k]}=?`).join(',');
    const vals = entries.map(([, v]) => v);
    this.db.prepare(`UPDATE sleep_state SET ${fields} WHERE id=1`).run(...vals);
  }

  // ===== 打工操作 =====
  getWorkState(): WorkRow {
    const r = this.db.prepare('SELECT * FROM work_state WHERE id=1').get() as any;
    return {
      isWorking: r.is_working, workStart: r.work_start,
      endTime: r.end_time, durationHours: r.duration_hours, earningRate: r.earning_rate
    };
  }

  updateWorkState(s: Partial<WorkRow>): void {
    const map: Record<string, string> = {
      isWorking: 'is_working', workStart: 'work_start',
      endTime: 'end_time', durationHours: 'duration_hours', earningRate: 'earning_rate'
    };
    const entries = Object.entries(s).filter(([k]) => map[k]);
    if (!entries.length) return;
    const fields = entries.map(([k]) => `${map[k]}=?`).join(',');
    const vals = entries.map(([, v]) => v);
    this.db.prepare(`UPDATE work_state SET ${fields} WHERE id=1`).run(...vals);
  }

  // ===== 用户打工操作 =====
  getUserWorkState(): UserWorkRow {
    const r = this.db.prepare('SELECT * FROM user_work_state WHERE id=1').get() as any;
    return {
      isWorking: r.is_working, workStart: r.work_start,
      endTime: r.end_time, durationHours: r.duration_hours, earningRate: r.earning_rate
    };
  }

  updateUserWorkState(s: Partial<UserWorkRow>): void {
    const map: Record<string, string> = {
      isWorking: 'is_working', workStart: 'work_start',
      endTime: 'end_time', durationHours: 'duration_hours', earningRate: 'earning_rate'
    };
    const entries = Object.entries(s).filter(([k]) => map[k]);
    if (!entries.length) return;
    const fields = entries.map(([k]) => `${map[k]}=?`).join(',');
    const vals = entries.map(([, v]) => v);
    this.db.prepare(`UPDATE user_work_state SET ${fields} WHERE id=1`).run(...vals);
  }

  // ===== 拉黑操作 =====
  getBlacklist(): BlacklistRow {
    let r = this.db.prepare('SELECT * FROM blacklist WHERE id=1').get() as any;
    if (!r) {
      // 初始化：插入默认行
      this.db.prepare('INSERT INTO blacklist(id) VALUES(1)').run();
      r = { blacklisted_by_ai: 0, blacklisted_by_user: 0, reason_by_ai: null };
    }
    return {
      blacklistedByAi: r.blacklisted_by_ai,
      blacklistedByUser: r.blacklisted_by_user,
      reasonByAi: r.reason_by_ai
    };
  }

  setBlacklistByAi(active: boolean, reason?: string): void {
    this.db.prepare(
      'UPDATE blacklist SET blacklisted_by_ai=?, reason_by_ai=? WHERE id=1'
    ).run(active ? 1 : 0, active ? (reason ?? null) : null);
  }

  setBlacklistByUser(active: boolean): void {
    this.db.prepare('UPDATE blacklist SET blacklisted_by_user=? WHERE id=1').run(active ? 1 : 0);
  }

  /** 统计数据 */
  getStats(): {
    totalMessages: number; userMessages: number; aiMessages: number;
    firstMessageAt: number | null; diaryCount: number; dreamCount: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c as number;
    const user = (this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE role=?').get('user') as any).c as number;
    const ai = (this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE role=?').get('assistant') as any).c as number;
    const firstRow = this.db.prepare('SELECT MIN(timestamp) as t FROM messages WHERE role=?').get('user') as any;
    const diary = (this.db.prepare('SELECT COUNT(*) as c FROM diary').get() as any).c as number;
    const dream = (this.db.prepare('SELECT COUNT(*) as c FROM dreams').get() as any).c as number;
    return {
      totalMessages: total, userMessages: user, aiMessages: ai,
      firstMessageAt: firstRow?.t ?? null, diaryCount: diary, dreamCount: dream,
    };
  }

  saveTask(task: Task): number {
    const r = this.db.prepare(
      'INSERT INTO tasks(name,description,trigger_time,created_by,executed,created_at,action_tags) VALUES(?,?,?,?,?,?,?)'
    ).run(task.name, task.description ?? null, task.triggerTime, task.createdBy, 0, Date.now(), task.actionTags ?? null);
    return Number(r.lastInsertRowid);
  }

  getPendingTasks(beforeTime?: number): Task[] {
    const cutoff = beforeTime ?? Date.now();
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE executed=0 AND trigger_time<=? ORDER BY trigger_time ASC'
    ).all(cutoff) as any[];
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      triggerTime: r.trigger_time, createdBy: r.created_by,
      executed: r.executed, createdAt: r.created_at,
      actionTags: r.action_tags ?? undefined
    }));
  }

  markTaskExecuted(id: number): void {
    this.db.prepare('UPDATE tasks SET executed=1 WHERE id=?').run(id);
  }

  getFutureTasks(): Task[] {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE executed=0 AND trigger_time>? ORDER BY trigger_time ASC'
    ).all(Date.now()) as any[];
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      triggerTime: r.trigger_time, createdBy: r.created_by,
      actionTags: r.action_tags ?? undefined
    }));
  }

  // ===== 道具操作 =====
  getInventory(owner: string): InventoryItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM inventory WHERE owner=? AND quantity>0'
    ).all(owner) as any[];
    return rows.map(r => ({ id: r.id, owner: r.owner, itemName: r.item_name, quantity: r.quantity }));
  }

  updateInventory(owner: string, itemName: string, delta: number): void {
    const existing = this.db.prepare(
      'SELECT id, quantity FROM inventory WHERE owner=? AND item_name=?'
    ).get(owner, itemName) as any;
    if (existing) {
      const newQty = Math.max(0, existing.quantity + delta);
      this.db.prepare('UPDATE inventory SET quantity=? WHERE id=?').run(newQty, existing.id);
    } else if (delta > 0) {
      this.db.prepare(
        'INSERT OR REPLACE INTO inventory(owner,item_name,quantity) VALUES(?,?,?)'
      ).run(owner, itemName, delta);
    }
  }

  // ===== 新闻操作 =====
  saveNews(item: NewsItem): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO news(title,source,url,summary,fetched_at,shared_at) VALUES(?,?,?,?,?,?)'
    ).run(item.title, item.source, item.url ?? null, item.summary ?? null, item.fetchedAt, item.sharedAt ?? null);
  }

  getUnsharedNews(limit = 5): NewsItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM news WHERE shared_at IS NULL ORDER BY fetched_at DESC LIMIT ?'
    ).all(limit) as any[];
    return rows.map(r => ({
      id: r.id, title: r.title, source: r.source, url: r.url,
      summary: r.summary, fetchedAt: r.fetched_at, sharedAt: r.shared_at
    }));
  }

  getRecentNews(limit = 10): NewsItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM news ORDER BY fetched_at DESC LIMIT ?'
    ).all(limit) as any[];
    return rows.map(r => ({
      id: r.id, title: r.title, source: r.source, url: r.url,
      summary: r.summary, fetchedAt: r.fetched_at, sharedAt: r.shared_at
    }));
  }

  markNewsShared(id: number): void {
    this.db.prepare('UPDATE news SET shared_at=? WHERE id=?').run(Date.now(), id);
  }

  // ===== 设置操作 =====
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
    return r ? r.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value);
  }

  // ===== Token 用量统计 =====
  recordApiUsage(entry: ApiUsageEntry): void {
    this.db.prepare(
      `INSERT INTO api_usage(endpoint,model,prompt_tokens,completion_tokens,total_tokens,created_at)
       VALUES(?,?,?,?,?,?)`
    ).run(
      entry.endpoint,
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
      entry.totalTokens,
      entry.createdAt
    );
  }

  getApiUsageSummary(since?: number): ApiUsageSummary {
    const row = since
      ? this.db.prepare(
        `SELECT COUNT(*) AS request_count,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM api_usage
         WHERE created_at >= ?`
      ).get(since) as any
      : this.db.prepare(
        `SELECT COUNT(*) AS request_count,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM api_usage`
      ).get() as any;
    return {
      requestCount: row.request_count,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens
    };
  }

  getApiUsageByModel(since?: number): ApiUsageByModel[] {
    const rows = since
      ? this.db.prepare(
        `SELECT endpoint, model,
                COUNT(*) AS request_count,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM api_usage
         WHERE created_at >= ?
         GROUP BY endpoint, model
         ORDER BY total_tokens DESC, request_count DESC`
      ).all(since) as any[]
      : this.db.prepare(
        `SELECT endpoint, model,
                COUNT(*) AS request_count,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM api_usage
         GROUP BY endpoint, model
         ORDER BY total_tokens DESC, request_count DESC`
      ).all() as any[];
    return rows.map(row => ({
      endpoint: row.endpoint,
      model: row.model,
      requestCount: row.request_count,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens
    }));
  }

  // ===== 工具方法 =====
  private camelToSnake(s: string): string {
    return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
  }

  close(): void {
    this.db.close();
  }
}
