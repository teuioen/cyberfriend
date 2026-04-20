/**
 * QQ 官方机器人信道
 * 使用 AppID + AppSecret 获取 Access Token 进行鉴权（新版 OAuth2 方式）
 * 需要在 https://bot.q.qq.com 申请官方机器人账号
 * 支持：频道私信 (DIRECT_MESSAGE) + C2C 单聊 (C2C_MESSAGE_CREATE)
 */
import WebSocket from 'ws';
import https from 'https';
import http from 'http';
import { BaseChannel, SendOptions } from './base';
import { QQChannelConfig } from '../config/types';
import { logger } from '../utils/logger';
import { stripAnsi } from '../utils/cliFormat';

const ACCESS_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

// OpCode
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Intent bit flags
const INTENT_DIRECT_MESSAGE = 1 << 12;    // 频道私信
const INTENT_C2C_MESSAGE = 1 << 25;       // C2C 单聊（需申请权限）

function httpsPost(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error(`JSON parse error: ${raw}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url: string, authorization: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'Authorization': authorization, 'User-Agent': 'CyberFriend/1.0' },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error(`JSON parse error: ${raw}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPostAuth(url: string, authorization: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': authorization,
        'User-Agent': 'CyberFriend/1.0',
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export class QQChannel extends BaseChannel {
  readonly name = 'QQ';

  private accessToken = '';
  private tokenExpiresAt = 0;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastSeq: number | null = null;
  private sessionId = '';
  private stopped = false;

  // Token 刷新退避状态
  private tokenRetryDelay = 60_000;   // 当前重试间隔（ms），初始 60s
  private static TOKEN_RETRY_MAX = 30 * 60_000;  // 最大退避 30 分钟

  // DM: 频道私信需要 dm_guild_id
  private dmGuildId = '';
  // C2C: 目标用户 openid
  private targetOpenId = '';
  // 最近一条消息 id（回复时需要 msg_id）
  private lastMsgId = '';
  // 回复序号，同一条消息允许多次回复（msg_seq 递增）
  private msgSeq = 1;

  constructor(private cfg: QQChannelConfig) {
    super();
    this.targetOpenId = cfg.targetOpenId ?? '';
  }

  // ===== Access Token =====

  private async refreshToken(): Promise<void> {
    const res = await httpsPost(ACCESS_TOKEN_URL, {
      appId: this.cfg.appId,
      clientSecret: this.cfg.appSecret,
    });
    if (!res.access_token) {
      throw new Error(`获取 Access Token 失败: ${JSON.stringify(res)}`);
    }
    this.accessToken = res.access_token;
    // expires_in 单位为秒（字符串），提前 60 秒刷新
    const expiresIn = parseInt(res.expires_in ?? '7200', 10);
    this.tokenExpiresAt = Date.now() + (expiresIn - 60) * 1000;
    this.tokenRetryDelay = 60_000;  // 成功后重置退避延迟
    logger.info(`[QQ] Access Token 获取成功，${expiresIn}秒后过期`);
  }

  private get authHeader(): string {
    return `QQBot ${this.accessToken}`;
  }

  private async ensureToken(): Promise<void> {
    if (Date.now() >= this.tokenExpiresAt) {
      await this.refreshToken();
    }
  }

  // ===== WebSocket =====

  async start(): Promise<void> {
    logger.info('[QQ] 正在初始化 QQ 官方机器人（Access Token 鉴权）...');
    await this.refreshToken();
    await this.connect();

    // 定时检查 Token 是否需要刷新（指数退避：首次 60s，失败后翻倍，最多 30min）
    const scheduleTokenCheck = () => {
      if (this.stopped) return;
      setTimeout(async () => {
        if (this.stopped) return;
        if (Date.now() >= this.tokenExpiresAt) {
          try {
            await this.refreshToken();
            logger.info('[QQ] Access Token 已自动刷新');
          } catch (e) {
            this.tokenRetryDelay = Math.min(this.tokenRetryDelay * 2, QQChannel.TOKEN_RETRY_MAX);
            logger.error(`[QQ] Token 刷新失败: ${e}（${this.tokenRetryDelay / 1000}s 后重试）`);
          }
        }
        scheduleTokenCheck();
      }, this.tokenRetryDelay);
    };
    scheduleTokenCheck();
  }

  private async connect(resume = false): Promise<void> {
    // 获取 WebSocket 网关地址
    let wsUrl: string;
    try {
      const gw = await httpsGet(`${API_BASE}/gateway/bot`, this.authHeader);
      wsUrl = gw.url;
      if (!wsUrl) throw new Error(`网关地址为空: ${JSON.stringify(gw)}`);
    } catch (e) {
      logger.error(`[QQ] 获取 WebSocket 网关失败: ${e}`);
      throw e;
    }

    logger.info(`[QQ] 连接 WebSocket: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => logger.debug('[QQ] WebSocket 已连接'));

    this.ws.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        this.handlePayload(payload, resume);
      } catch (e) {
        logger.error(`[QQ] 消息解析失败: ${e}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`[QQ] WebSocket 断开: ${code} ${reason}`);
      this.clearHeartbeat();
      if (!this.stopped) {
        setTimeout(() => this.connect(!!this.sessionId).catch(e => logger.error(`[QQ] 重连失败: ${e}`)), 5000);
      }
    });

    this.ws.on('error', (e) => logger.error(`[QQ] WebSocket 错误: ${e}`));
  }

  private handlePayload(payload: any, resumeMode: boolean): void {
    if (payload.s != null) this.lastSeq = payload.s;

    switch (payload.op) {
      case OP_HELLO: {
        const interval = payload.d?.heartbeat_interval ?? 40000;
        this.startHeartbeat(interval);
        if (resumeMode && this.sessionId) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }

      case OP_DISPATCH:
        this.handleDispatch(payload.t, payload.d);
        break;

      case OP_RECONNECT:
        logger.info('[QQ] 收到重连指令，正在重连...');
        this.ws?.close();
        break;

      case OP_INVALID_SESSION:
        logger.warn('[QQ] 会话无效，将重新 IDENTIFY');
        this.sessionId = '';
        this.lastSeq = null;
        this.ws?.close();
        break;

      case OP_HEARTBEAT_ACK:
        logger.debug('[QQ] 心跳 ACK');
        break;

      case OP_HEARTBEAT:
        this.sendHeartbeat();
        break;
    }
  }

  private handleDispatch(type: string, data: any): void {
    switch (type) {
      case 'READY':
        this.sessionId = data?.session_id ?? '';
        logger.info(`[QQ] 机器人已就绪，session: ${this.sessionId}`);
        break;

      case 'DIRECT_MESSAGE_CREATE': {
        // 频道私信
        const msg = data;
        const senderId: string = msg?.author?.id ?? '';
        if (!this.targetOpenId && senderId) {
          this.targetOpenId = senderId;
          logger.info(`[QQ] 绑定目标用户 openid: ${senderId}`);
        }
        if (this.targetOpenId && senderId !== this.targetOpenId) break;
        if (msg?.guild_id) this.dmGuildId = msg.guild_id;
        if (msg?.id) { this.lastMsgId = msg.id; this.msgSeq = 1; }
        const text = (msg?.content ?? '').trim();
        if (text && this.messageHandler) this.messageHandler(text).catch(e => logger.error(`[QQ] 消息处理错误: ${e}`));
        break;
      }

      case 'C2C_MESSAGE_CREATE': {
        // C2C 单聊
        const msg = data;
        const senderId: string = msg?.author?.user_openid ?? msg?.author?.id ?? '';
        if (!this.targetOpenId && senderId) {
          this.targetOpenId = senderId;
          logger.info(`[QQ] C2C 绑定目标用户 openid: ${senderId}`);
        }
        if (this.targetOpenId && senderId !== this.targetOpenId) break;
        if (msg?.id) { this.lastMsgId = msg.id; this.msgSeq = 1; }
        const text = (msg?.content ?? '').trim();
        if (text && this.messageHandler) this.messageHandler(text).catch(e => logger.error(`[QQ] C2C 消息处理错误: ${e}`));
        break;
      }

      default:
        logger.debug(`[QQ] 事件: ${type}`);
    }
  }

  private sendIdentify(): void {
    const intents = INTENT_DIRECT_MESSAGE | INTENT_C2C_MESSAGE;
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.authHeader,
        intents,
        shard: [0, 1],
      },
    });
    logger.debug(`[QQ] 发送 IDENTIFY, intents=${intents}`);
  }

  private sendResume(): void {
    this.send({
      op: OP_RESUME,
      d: {
        token: this.authHeader,
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    });
    logger.debug('[QQ] 发送 RESUME');
  }

  private startHeartbeat(interval: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private sendHeartbeat(): void {
    this.send({ op: OP_HEARTBEAT, d: this.lastSeq });
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close();
    logger.info('[QQ] 信道已停止');
  }

  // ===== 发送消息 =====

  async sendMessage(text: string, _options?: SendOptions): Promise<void> {
    if (!this.targetOpenId) {
      logger.warn('[QQ] 尚未绑定目标用户，无法发送消息');
      return;
    }
    try {
      await this.ensureToken();
      const seq = this.msgSeq++;

      // 优先尝试 C2C 发送（直接通过 openid）
      const c2cUrl = `${API_BASE}/v2/users/${this.targetOpenId}/messages`;
      const body: any = { content: text, msg_type: 0, msg_seq: seq };
      if (this.lastMsgId) body.msg_id = this.lastMsgId;

      const res = await httpsPostAuth(c2cUrl, this.authHeader, body);
      if (res.status && res.status >= 400) {
        logger.debug(`[QQ] C2C 发送失败(${res.status})，尝试频道私信...`);
        // fallback: 频道私信（频道私信不需要 msg_seq）
        if (this.dmGuildId) {
          const dmUrl = `${API_BASE}/dms/${this.dmGuildId}/messages`;
          const dmBody: any = { content: text, msg_type: 0 };
          if (this.lastMsgId) dmBody.msg_id = this.lastMsgId;
          await httpsPostAuth(dmUrl, this.authHeader, dmBody);
        }
      }
    } catch (e) {
      logger.error(`[QQ] 发送消息失败: ${e}`);
    }
  }

  async sendNotice(text: string): Promise<void> {
    await this.sendMessage(stripAnsi(text));
  }
}
