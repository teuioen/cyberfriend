/**
 * 商店系统
 * 支持用户和AI使用元购买物品，物品有不同效果
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Database } from '../database/db';
import { RelationshipSystem } from './relationship';
import { HealthSystem } from './health';
import { logger } from '../utils/logger';

export interface ShopItemEffect {
  health?: number;
  fatigue?: number;
  hunger?: number;       // 进食恢复饥饿值（食物类物品）
  affection?: number;
  cure_disease?: boolean;
}

export interface ShopItem {
  name: string;
  price: number;
  description: string;
  usesPerUnit?: number;   // 每购买1件提供的使用次数（默认1）
  effects?: ShopItemEffect;
  tags?: string[];        // 商品标签/种类（如 ["食物","饮料"]），用于 SHOP_LIST 过滤
}

interface ShopConfig {
  items: ShopItem[];
}

export class ShopSystem {
  private items: ShopItem[] = [];

  constructor(
    private db: Database,
    private relSys: RelationshipSystem,
    private healthSys: HealthSystem,
    shopConfigPath: string
  ) {
    this.loadConfig(shopConfigPath);
  }

  private loadConfig(configPath: string): void {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const cfg = yaml.load(raw) as any;
      // 规范化 snake_case → camelCase
      this.items = (cfg.items ?? []).map((item: any) => ({
        ...item,
        usesPerUnit: item.usesPerUnit ?? item.uses_per_unit ?? 1,
      }));
      logger.debug(`[Shop] 已加载 ${this.items.length} 件商品`);
    } catch (e) {
      logger.warn(`[Shop] 加载商店配置失败: ${e}，使用空商品列表`);
      this.items = [];
    }
  }

  /** 获取所有商品 */
  getItems(): ShopItem[] {
    return this.items;
  }

  /** 按名称精确查找商品 */
  findItem(name: string): ShopItem | undefined {
    return this.items.find(i => i.name === name);
  }

  /**
   * 模糊搜索商品（按相关度排序）
   * 优先精确匹配，其次包含所有关键词，最后包含任一关键词
   */
  findItems(query: string): ShopItem[] {
    const q = query.toLowerCase().trim();
    if (!q) return [...this.items]; // 空查询返回全部

    const exact = this.items.filter(i => i.name.toLowerCase() === q);
    if (exact.length === 1) return exact;

    // 分词匹配（空格 / 中文字符均作为分隔）
    const words = q.split(/\s+/).filter(Boolean);

    const allMatch = this.items.filter(i => {
      const name = i.name.toLowerCase();
      return words.every(w => name.includes(w));
    });
    if (allMatch.length) return allMatch;

    const anyMatch = this.items.filter(i => {
      const name = i.name.toLowerCase();
      return words.some(w => name.includes(w));
    });
    return anyMatch;
  }

  /**
   * 用户购买物品（物品进入用户背包）
   * @returns { success, message }
   */
  userBuy(itemName: string, qty = 1): { success: boolean; message: string } {
    const item = this.findItem(itemName);
    if (!item) {
      return { success: false, message: `商店里没有「${itemName}」，输入 /shop 查看商品列表` };
    }

    const totalCost = item.price * qty;
    const state = this.relSys.getState();
    if (state.userCurrency < totalCost) {
      return {
        success: false,
        message: `余额不足！需要 ${totalCost} 元，你当前有 ${Math.round(state.userCurrency)} 元`,
      };
    }

    // 扣款 + 添加到背包（每购买1件给 usesPerUnit 次使用）
    const uses = (item.usesPerUnit ?? 1) * qty;
    this.relSys.adjustCurrency('user', -totalCost);
    this.db.updateInventory('user', itemName, uses);
    logger.info(`[Shop] 用户购买了 ${qty} 个「${itemName}」，获得 ${uses} 次使用，花费 ${totalCost}`);

    const remaining = Math.round(state.userCurrency - totalCost);
    return {
      success: true,
      message: `✅ 购买成功！获得「${itemName}」x${uses} 次使用（-${totalCost} 元，剩余 ${remaining}）`,
    };
  }

  /**
   * AI 购买物品（物品进入AI背包）
   * @returns { success, message }
   */
  aiBuy(itemName: string, qty = 1): { success: boolean; message: string } {
    const item = this.findItem(itemName);
    if (!item) {
      return { success: false, message: `商店里没有「${itemName}」` };
    }

    const totalCost = item.price * qty;
    const state = this.relSys.getState();
    if (state.aiCurrency < totalCost) {
      return { success: false, message: `余额不足（AI当前 ${Math.round(state.aiCurrency)} 元）` };
    }

    this.relSys.adjustCurrency('ai', -totalCost);
    const uses = (item.usesPerUnit ?? 1) * qty;
    this.db.updateInventory('ai', itemName, uses);
    logger.info(`[Shop] AI购买了 ${qty} 个「${itemName}」，获得 ${uses} 次使用，花费 ${totalCost}`);

    return { success: true, message: `购买成功：${qty} 个「${itemName}」（${uses}次使用）` };
  }

  /**
   * 使用物品（来自用户背包）
   * @returns 效果描述
   */
  userUseItem(itemName: string): { success: boolean; message: string } {
    const items = this.db.getInventory('user');
    const entry = items.find(i => i.itemName === itemName);
    if (!entry || entry.quantity <= 0) {
      return { success: false, message: `你的背包里没有「${itemName}」` };
    }

    this.db.updateInventory('user', itemName, -1);
    return { success: true, message: `✅ 使用了「${itemName}」` };
  }

  /**
   * 使用物品（来自AI背包）并返回效果
   */
  aiUseItem(itemName: string): { success: boolean; message: string } {
    const items = this.db.getInventory('ai');
    const entry = items.find(i => i.itemName === itemName);
    if (!entry || entry.quantity <= 0) {
      return { success: false, message: `背包里没有「${itemName}」` };
    }

    const item = this.findItem(itemName);
    this.db.updateInventory('ai', itemName, -1);

    const effects: string[] = [];
    if (item?.effects) {
      const e = item.effects;
      if (e.cure_disease) { this.healthSys.cureDisease(); effects.push('疾病已治愈'); }
      if (e.health) { this.healthSys.adjust({ health: e.health }); effects.push(`健康${e.health > 0 ? '+' : ''}${e.health}`); }
      if (e.fatigue) { this.healthSys.adjust({ fatigue: e.fatigue }); effects.push(`疲惫${e.fatigue > 0 ? '+' : ''}${e.fatigue}`); }
      if (e.affection) { this.relSys.adjustAffection(e.affection); effects.push(`好感度+${e.affection}`); }
      if (e.hunger != null) {
        this.healthSys.eat(e.hunger);
        effects.push(`饥饿${e.hunger > 0 ? '+' : ''}${e.hunger}`);
      } else if (item.tags?.some(t => t === '食物' || t === '饮料' || t === '食品' || t === 'food')) {
        // 食物标签但未设置 hunger 效果时给默认恢复量
        this.healthSys.eat(20);
        effects.push('饥饿+20');
      }
    } else if (item?.tags?.some(t => t === '食物' || t === '饮料' || t === '食品' || t === 'food')) {
      this.healthSys.eat(20);
      effects.push('饥饿+20');
    }

    const effectStr = effects.length ? effects.join('，') : '使用成功';
    return { success: true, message: effectStr };
  }

  /** 格式化商品列表供显示 */
  formatShopList(): string {
    if (!this.items.length) return '商店暂无商品';
    const rel = this.relSys.getState();
    const lines = this.items.map(item =>
      `  ${item.name.padEnd(8)} ${String(item.price).padStart(4)} 元  ${item.description}`
    );
    return `\n===== 商店 =====\n${lines.join('\n')}\n\n你的余额: ${Math.round(rel.userCurrency)} 元\n  购买: /buy <物品名> [数量]`;
  }

  /** 返回所有可购买商品名称（可按标签过滤） */
  getItemNames(tag?: string): string[] {
    const items = tag
      ? this.items.filter(i => i.tags?.some(t => t.includes(tag)) || i.name.includes(tag))
      : this.items;
    return items.map(i => i.name);
  }
}
