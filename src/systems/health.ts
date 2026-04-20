import { Database, HealthRow, EmotionRow } from '../database/db';
import { HealthConfig } from '../config/types';

export interface HealthAdjust {
  health?: number;    // delta
  fatigue?: number;   // delta
}

const DISEASE_INFO: Record<string, { name: string; duration: number; healthDelta: number }> = {
  cold:       { name: '感冒',   duration: 48, healthDelta: -15 },
  depression: { name: '抑郁状态', duration: 72, healthDelta: -10 },
  anxiety:    { name: '焦虑症发作', duration: 24, healthDelta: -5 },
  fatigue:    { name: '过度疲劳', duration: 12, healthDelta: -8 },
};

export class HealthSystem {
  constructor(private db: Database, private cfg: HealthConfig) {}

  getState(): HealthRow {
    return this.db.getHealth();
  }

  getHealth(): number { return this.getState().healthValue; }
  getFatigue(): number { return this.getState().fatigue; }

  /** 调整健康/疲惫值 */
  adjust(adj: HealthAdjust): void {
    const current = this.getState();
    const patch: Partial<HealthRow> = {};
    if (adj.health !== undefined) {
      patch.healthValue = Math.min(100, Math.max(0, current.healthValue + adj.health));
    }
    if (adj.fatigue !== undefined) {
      patch.fatigue = Math.min(100, Math.max(0, current.fatigue + adj.fatigue));
    }
    this.db.updateHealth(patch);
  }

  /** 触发疾病 */
  triggerDisease(diseaseKey: string, durationOverride?: number): void {
    const info = DISEASE_INFO[diseaseKey];
    const name = info ? info.name : diseaseKey;
    const duration = durationOverride ?? (info?.duration ?? 24);
    this.db.updateHealth({ disease: name, diseaseDuration: duration });
    if (info) this.adjust({ health: info.healthDelta });
  }

  /** 治愈疾病 */
  cureDisease(diseaseName?: string): void {
    const current = this.getState();
    if (diseaseName && current.disease !== diseaseName) return;
    this.db.updateHealth({ disease: null, diseaseDuration: 0 });
  }

  /** 心跳时调用：处理疾病持续、随机发病等 */
  tick(emotionJoy: number, heartbeatMinutes: number, affection = 0, emotion?: EmotionRow): string[] {
    const events: string[] = [];
    const current = this.getState();
    const hoursPassed = heartbeatMinutes / 60;

    // 综合情绪健康评分（正面情绪 - 负面情绪）
    const wellnessScore = emotion
      ? (emotion.joy + emotion.excitement) - (emotion.sadness + emotion.anxiety + emotion.anger + emotion.fear) * 0.7
      : emotionJoy;

    // 疾病持续时间减少
    if (current.disease && current.diseaseDuration > 0) {
      const remaining = current.diseaseDuration - hoursPassed;
      // 高喜悦情绪 + 高好感度加速康复（情绪>65 → 1.3x；好感度>70 → 额外1.15x）
      let recoveryBonus = emotionJoy > 65 ? 1.3 : 1.0;
      if (affection > 70) recoveryBonus *= 1.15;
      const adjustedRemaining = remaining / recoveryBonus;
      if (adjustedRemaining <= 0) {
        this.db.updateHealth({ disease: null, diseaseDuration: 0 });
        events.push(`${current.disease}已痊愈`);
      } else {
        this.db.updateHealth({ diseaseDuration: Math.ceil(adjustedRemaining) });
      }
    }

    // 心理状态持续时间减少（好感度也加速心理康复）
    if (current.psychologyState !== 'normal' && current.psychologyDuration > 0) {
      const remaining = current.psychologyDuration - hoursPassed;
      const psychBonus = affection > 60 ? 1.2 : 1.0;
      const adjustedRemaining = remaining / psychBonus;
      if (adjustedRemaining <= 0) {
        this.db.updateHealth({ psychologyState: 'normal', psychologyDuration: 0 });
        events.push('心理状态恢复正常');
      } else {
        this.db.updateHealth({ psychologyDuration: Math.ceil(adjustedRemaining) });
      }
    }

    // 自然恢复 + 情绪健康加成
    const naturalRecovery = this.cfg.dailyRecovery * hoursPassed / 24;
    const wellnessBonus = wellnessScore > 60 ? 0.5 * hoursPassed / 24
      : wellnessScore > 30 ? 0.2 * hoursPassed / 24
      : wellnessScore < -30 ? -0.3 * hoursPassed / 24  // 长期负面情绪轻微损耗
      : 0;
    const fatigueIncrease = (this.cfg.fatigueDailyIncrease ?? 0) * hoursPassed / 24;
    const fatigueRecovery = this.cfg.fatigueDailyRecovery * hoursPassed / 24;
    this.adjust({ health: naturalRecovery + wellnessBonus, fatigue: fatigueIncrease - fatigueRecovery });

    // 随机发病（仅当健康时）
    const fresh = this.getState();
    if (!fresh.disease && fresh.fatigue >= 92) {
      this.triggerDisease('fatigue', 12);
      events.push('因为过度疲劳而状态变差');
      return events;
    }
    if (!fresh.disease && Math.random() < this.cfg.diseaseProbability) {
      const diseases = Object.keys(DISEASE_INFO);
      const randomDisease = diseases[Math.floor(Math.random() * diseases.length)];
      this.triggerDisease(randomDisease);
      events.push(`随机患上了${DISEASE_INFO[randomDisease]?.name ?? randomDisease}`);
    }

    return events;
  }

  /** 是否已死亡 */
  isDead(): boolean {
    return this.getState().healthValue <= 0;
  }

  /** 格式化状态用于提示词 */
  toPromptString(): string {
    const h = this.getState();
    const healthBar = `健康:${Math.round(h.healthValue)}/100`;
    const fatigueBar = `疲惫:${Math.round(h.fatigue)}/100`;
    const diseaseStr = h.disease ? ` | 患病:${h.disease}(剩余${h.diseaseDuration}小时)` : '';
    const psychStr = h.psychologyState !== 'normal' ? ` | 心理:${h.psychologyState}` : '';
    return `${healthBar} ${fatigueBar}${diseaseStr}${psychStr}`;
  }

  getDiseaseInfo(): Record<string, { name: string; duration: number }> {
    return Object.fromEntries(Object.entries(DISEASE_INFO).map(([k, v]) => [k, { name: v.name, duration: v.duration }]));
  }
}
