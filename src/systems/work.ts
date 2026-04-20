/**
 * 打工系统
 * AI可以自主选择去打工赚钱（只能由AI决定，用户只能劝说）
 */
import { Database, WorkRow } from '../database/db';
import { RelationshipSystem } from './relationship';
import { HealthSystem } from './health';
import { logger } from '../utils/logger';

export interface WorkConfig {
  earningPerHour: number;    // 每小时收益（虚拟币）
  maxHours: number;          // 单次最大打工时长（小时）
  fatiguePerHour?: number;   // 每小时额外增加的疲惫值
}

export interface WorkResult {
  endTime: Date;
  durationHours: number;
  expectedEarning: number;
}

export class WorkSystem {
  constructor(
    private db: Database,
    private relSys: RelationshipSystem,
    private healthSys: HealthSystem,
    private cfg: WorkConfig
  ) {}

  isWorking(): boolean {
    return this.getState().isWorking === 1;
  }

  /** AI决定去打工 */
  startWork(requestedHours: number): WorkResult {
    const hours = Math.max(0.5, Math.min(this.cfg.maxHours, requestedHours));
    const now = Date.now();
    const endTime = now + hours * 3600 * 1000;

    this.db.updateWorkState({
      isWorking: 1,
      workStart: now,
      endTime,
      durationHours: hours,
      earningRate: this.cfg.earningPerHour
    });

    logger.info(`[Work] Ta开始打工，时长 ${hours}h，预计收益 ${Math.round(hours * this.cfg.earningPerHour)} 虚拟币`);
    return {
      endTime: new Date(endTime),
      durationHours: hours,
      expectedEarning: Math.round(hours * this.cfg.earningPerHour)
    };
  }

  /** 心跳时检查是否打工结束，返回结束信息（null表示未结束） */
  checkWorkEnd(): { earned: number; hours: number } | null {
    const state = this.getState();
    if (!state.isWorking) return null;
    if (!state.endTime) return null;
    if (Date.now() < state.endTime) return null;

    const hours = state.durationHours ?? 1;
    const rate = state.earningRate ?? this.cfg.earningPerHour;
    const earned = Math.round(hours * rate);
    const fatigueGain = hours * (this.cfg.fatiguePerHour ?? 0);

    this.relSys.adjustCurrency('ai', earned);
    if (fatigueGain > 0) this.healthSys.adjust({ fatigue: fatigueGain });
    this.db.updateWorkState({ isWorking: 0, workStart: null, endTime: null });

    logger.info(`[Work] Ta打工结束，赚了 ${earned} 虚拟币，疲惫 +${Math.round(fatigueGain)}`);
    return { earned, hours };
  }

  /** 强制结束打工（不结算收益） */
  forceStop(): void {
    this.db.updateWorkState({ isWorking: 0, workStart: null, endTime: null });
    logger.info('[Work] Ta被强制下班');
  }

  getWorkDescription(): string {
    const state = this.getState();
    if (!state.isWorking || !state.endTime) return '';
    const remaining = Math.max(0, state.endTime - Date.now());
    const hours = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    const expectedEarning = Math.round((state.durationHours ?? 1) * (state.earningRate ?? this.cfg.earningPerHour));
    if (hours > 0) return `还有约 ${hours}h${mins}m 结束，预计收益 ${expectedEarning} 虚拟币`;
    return `还有约 ${mins} 分钟结束，预计收益 ${expectedEarning} 虚拟币`;
  }

  /** 获取打工结束时间（Date），打工中才有效 */
  getEndTime(): Date | null {
    const state = this.getState();
    if (!state.isWorking || !state.endTime) return null;
    return new Date(state.endTime);
  }

  toPromptString(): string {
    if (!this.isWorking()) return '空闲';
    return `打工中 (${this.getWorkDescription()})`;
  }

  getState(): WorkRow {
    return this.db.getWorkState();
  }
}
