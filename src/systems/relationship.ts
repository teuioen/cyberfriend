import { Database, RelationshipRow } from '../database/db';
import { EconomyConfig, RelationshipConfig } from '../config/types';

export class RelationshipSystem {
  private static readonly AFFECTION_ACTIVITY_KEY = 'relationship_affection_activity_at';

  constructor(
    private db: Database,
    private cfg: RelationshipConfig,
    private economyCfg: EconomyConfig
  ) {}

  getState(): RelationshipRow {
    return this.db.getRelationship();
  }

  /** 直接设置好感度（调试用） */
  setFavorDirect(value: number): void {
    this.setAffection(value, true);
  }

  /** 调整好感度 */
  adjustAffection(delta: number, markActivity = true): void {
    const current = this.getState();
    this.setAffection(current.affection + delta, markActivity);
  }

  /** 用户转账给AI */
  userToAi(amount: number): boolean {
    const current = this.getState();
    if (current.userCurrency < amount) return false;
    this.db.updateRelationship({
      userCurrency: current.userCurrency - amount,
      aiCurrency: current.aiCurrency + amount
    });
    return true;
  }

  /** AI转账给用户 */
  aiToUser(amount: number): boolean {
    const current = this.getState();
    if (current.aiCurrency < amount) return false;
    this.db.updateRelationship({
      aiCurrency: current.aiCurrency - amount,
      userCurrency: current.userCurrency + amount
    });
    return true;
  }

  /** 调整货币（delta可正可负） */
  adjustCurrency(owner: 'user' | 'ai', delta: number): void {
    const current = this.getState();
    if (owner === 'user') {
      this.db.updateRelationship({ userCurrency: Math.max(0, current.userCurrency + delta) });
    } else {
      this.db.updateRelationship({ aiCurrency: Math.max(0, current.aiCurrency + delta) });
    }
  }

  /** 每日发放虚拟货币 */
  dailyGrant(): void {
    const current = this.getState();
    this.db.updateRelationship({
      userCurrency: current.userCurrency + this.economyCfg.dailyCurrencyUser,
      aiCurrency: current.aiCurrency + this.economyCfg.dailyCurrencyAi
    });
  }

  /** 好感度自然衰减（长时间不互动） */
  decay(): void {
    const lastActivityRaw = this.db.getSetting(RelationshipSystem.AFFECTION_ACTIVITY_KEY);
    const current = this.getState();
    const lastActivityAt = lastActivityRaw ? parseInt(lastActivityRaw, 10) : current.updatedAt;
    const hoursSinceUpdate = (Date.now() - lastActivityAt) / (1000 * 60 * 60);
    if (hoursSinceUpdate > 24) {
      const daysDecayed = Math.floor(hoursSinceUpdate / 24);
      const delta = -this.cfg.affectionDecayPerDay * daysDecayed;
      this.adjustAffection(delta, false);
      this.db.setSetting(
        RelationshipSystem.AFFECTION_ACTIVITY_KEY,
        String(lastActivityAt + daysDecayed * 24 * 60 * 60 * 1000)
      );
    }
  }

  /** 格式化状态用于提示词 */
  toPromptString(): string {
    const r = this.getState();
    const aff = Math.round(r.affection);
    const affLabel = aff >= 80 ? '挚友' : aff >= 60 ? '好友' : aff >= 40 ? '普通朋友' : aff >= 20 ? '泛泛之交' : '陌生人';
    return `好感度:${aff}/100(${affLabel}) | 我的余额:${Math.round(r.aiCurrency)}虚拟币 | 用户余额:${Math.round(r.userCurrency)}虚拟币`;
  }

  private setAffection(value: number, markActivity: boolean): void {
    const clamped = Math.min(100, Math.max(0, value));
    this.db.updateRelationship({ affection: clamped });
    if (markActivity) {
      this.db.setSetting(RelationshipSystem.AFFECTION_ACTIVITY_KEY, String(Date.now()));
    }
  }
}
