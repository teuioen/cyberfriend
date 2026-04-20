/**
 * 飞书信道
 * 使用 @larksuiteoapi/node-sdk 的 WebSocket 长连接模式
 * 无需公网地址，直接订阅飞书事件
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { BaseChannel, MessageHandler, SendOptions, sleep } from './base';
import { FeishuChannelConfig } from '../config/types';
import { logger } from '../utils/logger';
import { stripForPlainText } from '../utils/cliFormat';

export class FeishuChannel extends BaseChannel {
  readonly name = 'feishu';
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private targetOpenId: string;

  constructor(private cfg: FeishuChannelConfig) {
    super();
    this.targetOpenId = cfg.targetUserId;
    this.client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      logger: {
        warn: () => {},
        info: () => {},
        error: (msg: string) => logger.error(`[Feishu SDK] ${msg}`),
        debug: () => {},
        trace: () => {},
      },
    });
    this.wsClient = new Lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      logger: {
        warn: () => {},
        info: () => {},
        error: (msg: string) => logger.error(`[Feishu WSClient] ${msg}`),
        debug: () => {},
        trace: () => {},
      },
    });
  }

  async start(): Promise<void> {
    logger.info('[Feishu] 正在初始化飞书信道...');
    const self = this;

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          const senderId: string = data?.sender?.sender_id?.open_id ?? '';
          if (!self.targetOpenId && senderId) {
            self.targetOpenId = senderId;
            logger.info(`[Feishu] 绑定目标用户: ${senderId}`);
          }
          if (self.targetOpenId && senderId !== self.targetOpenId) return;

          const msgType: string = data?.message?.message_type ?? '';
          if (msgType !== 'text') return;

          const content = JSON.parse(data?.message?.content ?? '{}');
          const text: string = (content.text ?? '').trim();
          if (!text) return;

          logger.debug(`[Feishu] 收到消息: ${text.slice(0, 50)}`);
          if (self.messageHandler) await self.messageHandler(text);
        } catch (e) {
          logger.error(`[Feishu] 消息处理错误: ${e}`);
        }
      },
    });

    this.wsClient.start({ eventDispatcher });
    logger.info('[Feishu] 飞书信道已启动，监听中...');
  }

  async stop(): Promise<void> {
    logger.info('[Feishu] 飞书信道已停止');
  }

  async sendMessage(text: string, _options?: SendOptions): Promise<void> {
    if (!this.targetOpenId) {
      logger.warn('[Feishu] 尚未绑定目标用户，无法发送消息');
      return;
    }
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: this.targetOpenId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (e) {
      logger.error(`[Feishu] 发送消息失败: ${e}`);
    }
  }

  async sendNotice(text: string): Promise<void> {
    await this.sendMessage(stripForPlainText(text));
  }
}
