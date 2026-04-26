/**
 * 用户打工系统
 * 用户可以去打工赚元，打工期间禁止与AI对话（"手机上缴"）
 * 可以"跑路"但没有工资
 */
import { Database, UserWorkRow } from '../database/db';
import { RelationshipSystem } from './relationship';
import { WorkConfig } from './work';
import { logger } from '../utils/logger';

export class UserWorkSystem {
  constructor(
    private db: Database,
    private relSys: RelationshipSystem,
    private cfg: WorkConfig
  ) {}

  isWorking(): boolean {
    return this.getState().isWorking === 1;
  }

  /** 用户开始打工 */
  startWork(requestedHours?: number): { endTime: Date; durationHours: number; expectedEarning: number } {
    const minH = 0.5;
    const maxH = this.cfg.maxHours;
    const hours = requestedHours
      ? Math.max(minH, Math.min(maxH, requestedHours))
      : Math.round((1 + Math.random() * 7) * 2) / 2; // 随机 1-8h，精确到0.5h

    const now = Date.now();
    const endTime = now + hours * 3600 * 1000;

    this.db.updateUserWorkState({
      isWorking: 1,
      workStart: now,
      endTime,
      durationHours: hours,
      earningRate: this.cfg.earningPerHour
    });

    logger.info(`[UserWork] 用户开始打工，时长 ${hours}h，预计收益 ${Math.round(hours * this.cfg.earningPerHour)}`);
    return {
      endTime: new Date(endTime),
      durationHours: hours,
      expectedEarning: Math.round(hours * this.cfg.earningPerHour)
    };
  }

  /** 心跳检查是否到点下班（返回收益，null 表示还没结束） */
  checkWorkEnd(): { earned: number; hours: number } | null {
    const state = this.getState();
    if (!state.isWorking || !state.endTime) return null;
    if (Date.now() < state.endTime) return null;

    const hours = state.durationHours ?? 1;
    const rate = state.earningRate ?? this.cfg.earningPerHour;
    const earned = Math.round(hours * rate);

    this.relSys.adjustCurrency('user', earned);
    this.db.updateUserWorkState({ isWorking: 0, workStart: null, endTime: null });

    logger.info(`[UserWork] 用户打工结束，赚了 ${earned} 元`);
    return { earned, hours };
  }

  /** 用户跑路（按实际劳动时间结算，扣除跑路费 10 元） */
  quitWork(): { earnedBeforeFee: number; fee: number; net: number } {
    const state = this.getState();
    const quitFee = 10;
    let net = 0;
    let earnedBeforeFee = 0;
    if (state.isWorking && state.workStart) {
      const elapsedHours = (Date.now() - state.workStart) / 3600000;
      const rate = state.earningRate ?? this.cfg.earningPerHour;
      earnedBeforeFee = Math.round(elapsedHours * rate);
      net = Math.max(0, earnedBeforeFee - quitFee);
      if (net > 0) this.relSys.adjustCurrency('user', net);
    }
    this.db.updateUserWorkState({ isWorking: 0, workStart: null, endTime: null });
    logger.info(`[UserWork] 用户跑路，劳动所得 ${earnedBeforeFee} 扣除跑路费 ${quitFee}，实得 ${net} 元`);
    return { earnedBeforeFee, fee: quitFee, net };
  }

  getWorkDescription(): string {
    const state = this.getState();
    if (!state.isWorking || !state.endTime) return '';
    const remaining = Math.max(0, state.endTime - Date.now());
    const hours = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    const expectedEarning = Math.round((state.durationHours ?? 1) * (state.earningRate ?? this.cfg.earningPerHour));
    if (hours > 0) return `还有约 ${hours}h${mins}m 结束，预计收益 ${expectedEarning} 元`;
    return `还有约 ${mins} 分钟结束，预计收益 ${expectedEarning} 元`;
  }

  private getState(): UserWorkRow {
    return this.db.getUserWorkState();
  }
}
