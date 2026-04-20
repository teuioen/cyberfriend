/**
 * 信道基础接口
 * 所有通信信道（CLI、微信、QQ、飞书等）实现此接口
 */

import { logger } from '../utils/logger';
import { stripAnsi } from '../utils/cliFormat';

export type MessageHandler = (text: string, userId?: string) => Promise<void>;

export interface SendOptions {
  delayMs?: number;
}

export interface IChannel {
  /** 信道名称 */
  readonly name: string;

  /** 启动信道，开始监听用户输入 */
  start(): Promise<void>;

  /** 停止信道 */
  stop(): Promise<void>;

  /** 发送消息给用户（单条） */
  sendMessage(text: string, options?: SendOptions): Promise<void>;

  /** 发送多条消息（带随机延迟） */
  sendMessages(texts: string[], minDelayMs?: number, maxDelayMs?: number, typingSpeedCharsPerSec?: number): Promise<void>;

  /** 注册消息接收处理器 */
  onMessage(handler: MessageHandler): void;

  /** 发送系统通知（不计入对话）*/
  sendNotice(text: string): Promise<void>;
}

/** 基础信道抽象类，提供通用的多消息发送逻辑 */
export abstract class BaseChannel implements IChannel {
  abstract readonly name: string;
  protected messageHandler?: MessageHandler;
  /** 子类设为 false 可跳过发送日志（CLI 自行打印，不需要重复 logger） */
  protected logOutgoing = true;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(text: string, options?: SendOptions): Promise<void>;
  abstract sendNotice(text: string): Promise<void>;

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** 批量发送前的钩子（子类可覆盖） */
  protected beforeBatch(): void {}
  /** 批量发送后的钩子（子类可覆盖） */
  protected afterBatch(): void {}

  /** 对单条消息文本做通用清理（子类可覆盖以调整规则） */
  protected cleanText(text: string): string {
    // 去除 ANSI 转义（防 AI 误带颜色码）
    text = stripAnsi(text);
    // 去掉末尾句号（中文。或英文.）
    text = text.replace(/[。\.]+$/u, '').trim();
    return text;
  }

  async sendMessages(texts: string[], minDelayMs = 500, maxDelayMs = 3000, typingSpeedCharsPerSec = 10): Promise<void> {
    this.beforeBatch();
    for (let i = 0; i < texts.length; i++) {
      if (i > 0) {
        const textLen = texts[i].length;
        // 打字时间 = 字数 / 速度 * 1000ms
        const typingMs = (textLen / typingSpeedCharsPerSec) * 1000;
        // 随机抖动：50~300ms
        const jitter = 50 + Math.random() * 250;
        const delay = Math.min(maxDelayMs, Math.max(minDelayMs, typingMs + jitter));
        await sleep(delay);
      }
      const text = this.cleanText(texts[i]);
      if (!text) continue;
      // 记录AI回复内容（便于排查问题），CLI 自行打印所以跳过
      if (this.logOutgoing) logger.debug(`[${this.name}] → ${text}`);
      await this.sendMessage(text);
    }
    this.afterBatch();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
