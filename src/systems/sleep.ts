import { Database, SleepRow, DreamEntry, DreamType } from '../database/db';
import { SleepConfig, HealthConfig } from '../config/types';
import { EmotionDeltas } from './emotion';

export interface SleepResult {
  started: boolean;
  wakeTime: Date;
  durationHours: number;
  quality: number;
}

export interface CompletedSleepInfo {
  sleepStart: number;
  wakeTime: number;
  durationHours: number;
  quality: number;
}

export class SleepSystem {
  private forceWokenAt = 0;
  private lastCompletedSleep: CompletedSleepInfo | null = null;

  constructor(
    private db: Database,
    private cfg: SleepConfig,
    private healthCfg: HealthConfig
  ) {}

  getSleepState(): SleepRow {
    return this.db.getSleepState();
  }

  isAsleep(): boolean {
    return this.db.getSleepState().isSleeping === 1;
  }

  /** 开始睡眠，返回醒来时间 */
  startSleep(requestedHours?: number, healthValue = 100, emotionJoy = 50): SleepResult {
    const duration = requestedHours
      ? Math.min(this.cfg.maxDurationHours, Math.max(this.cfg.minDurationHours, requestedHours))
      : this.randomDuration();

    // 睡眠质量受情绪和健康影响
    const baseQuality = (emotionJoy * 0.4 + healthValue * 0.6);
    const quality = Math.min(100, Math.max(20, baseQuality + (Math.random() * 20 - 10)));

    const sleepStart = Date.now();
    const wakeTime = sleepStart + duration * 60 * 60 * 1000;

    this.db.updateSleepState({
      isSleeping: 1,
      sleepStart,
      wakeTime,
      durationHours: duration,
      quality
    });

    return { started: true, wakeTime: new Date(wakeTime), durationHours: duration, quality };
  }

  /** 检查是否到了醒来时间 */
  checkWakeUp(): boolean {
    const state = this.getSleepState();
    if (!state.isSleeping) return false;
    if (state.wakeTime && Date.now() >= state.wakeTime) {
      this.wakeUp(state.quality ?? 70);
      return true;
    }
    return false;
  }

  /** 醒来处理 */
  private wakeUp(quality: number): void {
    const state = this.getSleepState();
    this.lastCompletedSleep = {
      sleepStart: state.sleepStart ?? Date.now(),
      wakeTime: Date.now(),
      durationHours: state.durationHours ?? 0,
      quality,
    };
    this.db.updateSleepState({ isSleeping: 0, sleepStart: null, wakeTime: null });
    // 睡眠恢复健康和减少疲惫
    const healthBonus = this.healthCfg.sleepHealthBonus * (quality / 100) * 2;
    const fatigueMinus = this.healthCfg.sleepFatigueMinus * (quality / 100);
    const current = this.db.getHealth();
    this.db.updateHealth({
      healthValue: Math.min(100, current.healthValue + healthBonus),
      fatigue: Math.max(0, current.fatigue - fatigueMinus)
    });
  }

  /** 强制唤醒 */
  forceWakeUp(): void {
    const state = this.getSleepState();
    if (state.isSleeping) this.wakeUp(state.quality ?? 50);
    this.forceWokenAt = Date.now();
  }

  /** 是否在最近一段时间内被强制唤醒（默认10分钟内） */
  wasRecentlyForceWoken(withinMs = 10 * 60 * 1000): boolean {
    return this.forceWokenAt > 0 && Date.now() - this.forceWokenAt < withinMs;
  }

  /** 保存梦境（带类型） */
  saveDream(content: string, type: DreamType = 'neutral'): void {
    this.db.saveDream({ content, dreamType: type, createdAt: Date.now() });
  }

  /** 获取最近梦境 */
  getRecentDreams(limit = 3): DreamEntry[] {
    return this.db.getRecentDreams(limit);
  }

  /** 获取距离醒来的剩余时间描述 */
  getWakeUpDescription(): string {
    const state = this.getSleepState();
    if (!state.isSleeping || !state.wakeTime) return '';
    const remaining = state.wakeTime - Date.now();
    if (remaining <= 0) return '马上就要醒了';
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `还有约${hours}小时${minutes}分钟醒来`;
    return `还有约${minutes}分钟醒来`;
  }

  /** 获取预计醒来时间（Date），睡眠中才有效 */
  getWakeTime(): Date | null {
    const state = this.getSleepState();
    if (!state.isSleeping || !state.wakeTime) return null;
    return new Date(state.wakeTime);
  }

  /** 判断当前时间是否适合睡眠 */
  isSleepTime(): boolean {
    const hour = new Date().getHours();
    return hour >= this.cfg.startHour || hour < this.cfg.endHour;
  }

  /** 根据睡眠质量和梦境类型计算醒来后的情绪影响 */
  computeWakeEmotionEffect(quality: number, dreamType?: DreamType): EmotionDeltas {
    const d: EmotionDeltas = {};
    // 睡眠质量影响
    if (quality >= 80) {
      d.joy = 8; d.anxiety = -6; d.excitement = 3;
    } else if (quality >= 60) {
      d.joy = 3; d.anxiety = -2;
    } else if (quality >= 40) {
      d.joy = -2; d.anxiety = 3;
    } else {
      d.joy = -6; d.anxiety = 6; d.anger = 3; d.sadness = 3;
    }
    // 梦境类型叠加
    if (dreamType === 'sweet') {
      d.joy = (d.joy ?? 0) + 5; d.excitement = (d.excitement ?? 0) + 3;
    } else if (dreamType === 'nightmare') {
      d.fear = 10; d.anxiety = (d.anxiety ?? 0) + 8; d.joy = (d.joy ?? 0) - 6;
    } else if (dreamType === 'weird') {
      d.excitement = (d.excitement ?? 0) + 2;
    }
    return d;
  }

  /** 是否应该做梦 */
  shouldDream(): boolean {
    return Math.random() < this.cfg.dreamProbability;
  }

  shouldSleepForFatigue(fatigue: number): boolean {
    return fatigue >= (this.cfg.fatigueSleepThreshold ?? 72);
  }

  shouldForceSleepForFatigue(fatigue: number): boolean {
    return fatigue >= (this.cfg.fatigueForceSleepThreshold ?? 90);
  }

  getLastCompletedSleep(): CompletedSleepInfo | null {
    return this.lastCompletedSleep;
  }

  private randomDuration(): number {
    const min = this.cfg.minDurationHours;
    const max = this.cfg.maxDurationHours;
    return parseFloat((min + Math.random() * (max - min)).toFixed(1));
  }
}
