import { Database, EmotionRow } from '../database/db';
import { EmotionConfig } from '../config/types';
import { logger } from '../utils/logger';

export type EmotionKey = 'joy' | 'sadness' | 'anxiety' | 'anger' | 'fear' | 'excitement' | 'disgust' | 'shame' | 'curiosity';
export type EmotionDeltas = Partial<Record<EmotionKey, number>>;

const VALID_EMOTION_KEYS = new Set<string>(['joy','sadness','anxiety','anger','fear','excitement','disgust','shame','curiosity']);

const EMOTION_NAMES: Record<EmotionKey, string> = {
  joy: '喜悦', sadness: '悲伤', anxiety: '焦虑', anger: '愤怒',
  fear: '恐惧', excitement: '兴奋', disgust: '厌恶', shame: '羞耻', curiosity: '好奇'
};

export class EmotionSystem {
  constructor(private db: Database, private cfg: EmotionConfig) {}

  getState(): EmotionRow {
    return this.db.getEmotions();
  }

  /** 调整情绪值，支持相对(带+/-)或绝对值；忽略未知情绪键 */
  update(deltas: EmotionDeltas | Record<string, number>): void {
    const current = this.getState();
    const patch: Partial<EmotionRow> = {};
    for (const [key, delta] of Object.entries(deltas) as [string, number][]) {
      if (!VALID_EMOTION_KEYS.has(key)) {
        logger.debug(`[Emotion] 忽略未知情绪键: ${key}`);
        continue;
      }
      const cur = (current as any)[key] as number;
      const newVal = Math.min(this.cfg.maxValue, Math.max(this.cfg.minValue, cur + delta));
      (patch as any)[key] = newVal;
    }
    if (Object.keys(patch).length) this.db.updateEmotions(patch);
  }

  /** 情绪自然衰减，向中值靠拢 */
  decay(): void {
    const current = this.getState();
    const patch: Partial<EmotionRow> = {};
    const neutral = this.cfg.neutralValue;
    const rate = this.cfg.decayRate;
    const keys: EmotionKey[] = ['joy','sadness','anxiety','anger','fear','excitement','disgust','shame','curiosity'];
    for (const key of keys) {
      const cur = (current as any)[key] as number;
      const newVal = cur + (neutral - cur) * rate;
      (patch as any)[key] = parseFloat(newVal.toFixed(2));
    }
    this.db.updateEmotions(patch);
  }

  /** 获取当前主导情绪（偏离中值最大的） */
  getDominant(): { key: EmotionKey; name: string; value: number } {
    const current = this.getState();
    const neutral = this.cfg.neutralValue;
    const keys: EmotionKey[] = ['joy','sadness','anxiety','anger','fear','excitement','disgust','shame','curiosity'];
    let maxDeviation = 0;
    let dominant: EmotionKey = 'joy';
    for (const key of keys) {
      const dev = Math.abs((current[key] as number) - neutral);
      if (dev > maxDeviation) { maxDeviation = dev; dominant = key; }
    }
    return { key: dominant, name: EMOTION_NAMES[dominant], value: current[dominant] as number };
  }

  /** 获取当前情绪的简短描述（用于提示词） */
  toPromptString(): string {
    const e = this.getState();
    const keys: EmotionKey[] = ['joy','sadness','anxiety','anger','fear','excitement','disgust','shame','curiosity'];
    const parts = keys
      .map(k => ({ k, v: (e as any)[k] as number, dev: Math.abs(((e as any)[k] as number) - this.cfg.neutralValue) }))
      .filter(x => x.dev > 10)  // 只显示偏离中值超过10的情绪
      .sort((a, b) => b.dev - a.dev)
      .slice(0, 5)
      .map(x => `${EMOTION_NAMES[x.k]}${Math.round(x.v)}`);
    return parts.length ? parts.join(' | ') : '情绪平稳';
  }

  /** 完整情绪状态字符串 */
  toFullString(): string {
    const e = this.getState();
    const keys: EmotionKey[] = ['joy','sadness','anxiety','anger','fear','excitement','disgust','shame','curiosity'];
    return keys.map(k => `${EMOTION_NAMES[k]}:${Math.round((e as any)[k] as number)}`).join(' ');
  }

  /** 根据情绪状态生成性格描述标签（用于提示词） */
  getMoodTag(): string {
    const dom = this.getDominant();
    const val = dom.value;
    if (dom.key === 'joy' && val > 70) return '心情很好，活泼开朗';
    if (dom.key === 'joy' && val > 55) return '心情不错，比较轻松';
    if (dom.key === 'sadness' && val > 70) return '心情低落，有些沮丧';
    if (dom.key === 'sadness' && val > 55) return '有点郁郁寡欢';
    if (dom.key === 'anxiety' && val > 70) return '内心焦虑不安';
    if (dom.key === 'anger' && val > 70) return '心情烦躁，容易发火';
    if (dom.key === 'anger' && val > 55) return '有点不耐烦';
    if (dom.key === 'excitement' && val > 70) return '很兴奋，精力充沛';
    if (dom.key === 'fear' && val > 60) return '有些担忧和恐惧';
    return '情绪平稳';
  }
}
