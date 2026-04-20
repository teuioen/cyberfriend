/**
 * 微信信道实现
 * 基于 @wechatbot/wechatbot SDK，支持扫码登录和会话持久化
 *
 * 使用方式：
 *   1. config/app.yaml 中 channels.enabled 加入 "wechat"
 *   2. 可选：填写 channels.wechat.targetUserId 限定目标用户
 *   3. 启动程序后，终端显示二维码，用微信扫码登录
 *   4. 登录凭证自动保存，重启后无需重新扫码
 *
 * 注意：@wechatbot/wechatbot 要求 Node.js >= 22，Node 20 可能存在兼容性问题
 */
import { BaseChannel, SendOptions, sleep } from './base';
import { WechatChannelConfig } from '../config/types';
import { logger } from '../utils/logger';
import { stripForPlainText } from '../utils/cliFormat';

export class WechatChannel extends BaseChannel {
  readonly name = 'WeChat';
  private bot: any = null;
  private targetUserId: string | null = null;
  private cfg: WechatChannelConfig;
  private pollerStopped = false;

  constructor(cfg: WechatChannelConfig) {
    super();
    this.cfg = cfg;
    // 若配置了固定目标用户，直接记录
    if (cfg.targetUserId) {
      this.targetUserId = cfg.targetUserId;
    }
  }

  async start(): Promise<void> {
    logger.info('[WeChat] 正在初始化微信信道...');

    let WeChatBot: any;
    try {
      const mod = await import('@wechatbot/wechatbot');
      WeChatBot = mod.WeChatBot;
    } catch (e) {
      logger.error(`[WeChat] 加载 @wechatbot/wechatbot 失败: ${e}\n  请运行: npm install @wechatbot/wechatbot`);
      return;
    }

    this.bot = new WeChatBot({
      storage: 'file',
      storageDir: this.cfg.storageDir || './data/wechat-session',
      // 默认 silent：SDK 内部轮询错误非常频繁（网络波动导致 fetch failed），
      // 我们通过事件监听器捕获重要事件，不依赖 SDK 的日志输出。
      logLevel: (this.cfg.logLevel || 'silent') as any,
    });

    // ── 修复SDK长轮询超时问题 ──────────────────────────────────────────
    // pollQrStatus 是长轮询接口（服务端挂起等待扫码），但 SDK 的 apiGet 
    // 硬编码了 15s 超时，导致未扫码时连续超时3次后失败。
    // 解决：patch apiGet，对 QR状态轮询接口使用 120s 超时。
    const httpClient = (this.bot as any).http;
    const origApiGet = httpClient.apiGet.bind(httpClient);
    httpClient.apiGet = async (baseUrl: string, path: string, headers: any) => {
      if (path.includes('get_qrcode_status')) {
        // 直接调用底层 request()，绕过硬编码 15s 超时
        const normalizedBase = baseUrl.replace(/\/+$/, '') + '/';
        const url = new URL(path, normalizedBase).toString();
        const response = await httpClient.request({
          method: 'GET',
          url,
          headers,
          timeoutMs: 120_000,  // 2分钟，足够用户扫码
        });
        return response.data;
      }
      return origApiGet(baseUrl, path, headers);
    };

    // QR回调（注意：loginCallbacks构造参数在SDK中未被使用，需在login()时传入）
    const loginCallbacks = {
      onQrUrl: (url: string) => this.renderQr(url),
      onScanned: () => {
        console.log('\n\x1b[36m[WeChat] 已扫码，等待确认...\x1b[0m');
      },
      onExpired: () => {
        console.log('\n\x1b[33m[WeChat] ⚠️  二维码已过期，正在重新生成...\x1b[0m');
      },
    };

    // 登录成功
    this.bot.on('login', (creds: any) => {
      logger.info(`[WeChat] 登录成功: ${creds.accountId}`);
      console.log(`\n\x1b[32m[WeChat] 微信登录成功！账号: ${creds.accountId}\x1b[0m`);
      if (this.targetUserId) {
        console.log(`\x1b[32m[WeChat] 目标用户: ${this.targetUserId}\x1b[0m\n`);
      } else {
        // console.log('\x1b[33m[WeChat] 未配置目标用户，将响应第一个来消息的人\x1b[0m\n');
      }
    });

    // 会话过期（自动重连）
    let reconnectAttempt = 0;
    const maxReconnect = this.cfg.maxReconnectAttempts ?? 3;
    const attemptReconnect = async () => {
      reconnectAttempt++;
      if (reconnectAttempt > maxReconnect) {
        logger.error('[WeChat] 自动重连次数已达上限，请手动重启程序');
        console.log('\n\x1b[31m[WeChat] ❌ 自动重连失败，请手动重启程序重新扫码\x1b[0m');
        return;
      }
      const delayMs = reconnectAttempt * 15000; // 15s, 30s, 45s
      logger.info(`[WeChat] ${delayMs / 1000}s后进行第${reconnectAttempt}/${maxReconnect}次重连...`);
      console.log(`\n\x1b[33m[WeChat] 🔄 ${delayMs / 1000}s后自动重连（${reconnectAttempt}/${maxReconnect}）...\x1b[0m`);
      await sleep(delayMs);
      try {
        await this.bot.login({ callbacks: loginCallbacks });
        reconnectAttempt = 0;
        logger.info('[WeChat] 重连成功');
        console.log('\n\x1b[32m[WeChat] 重连成功！\x1b[0m');
      } catch (e) {
        logger.warn(`[WeChat] 第${reconnectAttempt}次重连失败: ${e}`);
        await attemptReconnect();
      }
    };

    this.bot.on('session:expired', () => {
      logger.warn('[WeChat] 会话已过期，尝试自动重连...');
      console.log('\n\x1b[33m[WeChat] ⚠️  会话已过期，尝试自动重连...\x1b[0m');
      this.targetUserId = this.cfg.targetUserId || null;
      attemptReconnect();
    });

    // 会话恢复（重启后自动登录）
    this.bot.on('session:restored', (creds: any) => {
      logger.info(`[WeChat] 会话已自动恢复: ${creds.accountId}`);
      console.log(`\n\x1b[32m[WeChat] 微信会话已恢复（无需扫码）: ${creds.accountId}\x1b[0m\n`);
    });

    // SDK 内部 poller 已有错误日志，此处仅阻止未捕获的 error 事件导致进程崩溃
    this.bot.on('error', (_err: Error) => { /* 由 SDK 内部 poller 日志处理 */ });

    // 注册消息处理器
    this.bot.onMessage(async (msg: any) => {
      const fromId: string = msg.userId;

      // 目标用户过滤
      if (this.cfg.targetUserId && fromId !== this.cfg.targetUserId) {
        logger.debug(`[WeChat] 忽略来自 ${fromId} 的消息（不是目标用户）`);
        return;
      }

      // 首次收到消息时锁定目标用户
      if (!this.targetUserId) {
        this.targetUserId = fromId;
        logger.info(`[WeChat] 已锁定目标用户: ${fromId}`);
        console.log(`\x1b[32m[WeChat] 已锁定目标用户: ${fromId}\x1b[0m`);
      }

      // 图片消息：下载为 buffer 并转为 base64 data URL
      let imageDataUrl: string | undefined;
      if ((msg.type ?? 'text') === 'image') {
        try {
          const media = await this.bot.download(msg);
          if (media?.data) {
            // media.format 可能是 'jpeg'/'png'/'gif'/'webp' 等
            const fmt = media.format ?? 'jpeg';
            const mimeType = fmt.startsWith('image/') ? fmt : `image/${fmt}`;
            imageDataUrl = `data:${mimeType};base64,${media.data.toString('base64')}`;
            logger.debug(`[WeChat] 图片已下载 (${mimeType})，大小: ${media.data.length} bytes`);
          }
        } catch (e) {
          logger.warn(`[WeChat] 图片下载失败: ${e}`);
        }
      }

      // 构建用户消息文本（支持多种消息类型）
      const userText = this.buildUserText(msg, imageDataUrl);
      if (!userText) return;

      logger.debug(`[WeChat] 收到消息 [${fromId}]: ${userText.slice(0, 80)}`);

      if (this.messageHandler) {
        await this.messageHandler(userText, fromId).catch(e => {
          logger.error(`[WeChat] 消息处理异常: ${e}`);
        });
      }
    });

    // 启动：先登录（有凭证自动跳过），再异步开始长轮询（带自动重启）
    try {
      // 关键：callbacks 必须在 login() 时传入，构造函数的 loginCallbacks 不被 SDK 使用
      await this.bot.login({ callbacks: loginCallbacks });

      // 自动重启轮询循环：网络中断后延迟重试，直到 stop() 被调用
      const startPoller = async () => {
        let retryDelay = 5000;
        while (!this.pollerStopped) {
          try {
            await this.bot.start();
            // start() 正常返回（bot.stop() 调用）则退出循环
            break;
          } catch (e: any) {
            if (this.pollerStopped) break;
            const msg: string = e?.message ?? String(e);
            const isNetwork = /fetch|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg);
            if (isNetwork) {
              logger.warn(`[WeChat] 轮询网络中断，${retryDelay / 1000}s 后重试...`);
              await sleep(retryDelay);
              retryDelay = Math.min(retryDelay * 2, 60_000); // 指数退避，最长 60s
            } else {
              logger.error(`[WeChat] 长轮询异常: ${msg}`);
              break; // 非网络错误，不再重试
            }
          }
        }
      };
      startPoller();
      logger.info('[WeChat] Bot 已启动，开始接收消息');
    } catch (e) {
      logger.error(`[WeChat] 启动失败: ${e}`);
    }
  }

  async stop(): Promise<void> {
    this.pollerStopped = true;
    if (this.bot) {
      try {
        await this.bot.stop();
        logger.info('[WeChat] Bot 已停止');
      } catch (e) {
        logger.warn(`[WeChat] 停止时出错: ${e}`);
      }
    }
  }

  async sendMessage(text: string, options?: SendOptions): Promise<void> {
    if (!this.bot) {
      logger.warn('[WeChat] Bot 未初始化，消息未发送');
      return;
    }
    if (!this.targetUserId) {
      logger.warn('[WeChat] 暂无目标用户，消息未发送（等待对方先发消息）');
      return;
    }
    if (options?.delayMs) await sleep(options.delayMs);

    try {
      // 发送"正在输入"指示（模拟真实感）
      await this.bot.sendTyping(this.targetUserId).catch(() => {});
      await this.bot.send(this.targetUserId, text);
      logger.debug(`[WeChat] 已发送: ${text.slice(0, 40)}`);
    } catch (e) {
      logger.error(`[WeChat] 发送消息失败: ${e}`);
    }
  }

  async sendNotice(text: string): Promise<void> {
    await this.sendMessage(stripForPlainText(text));
  }

  /**
   * 将收到的消息对象转换为统一的文字描述
   * 支持：文本、图片、语音（含转文字）、文件、视频、引用消息
   */
  private buildUserText(msg: any, imageDataUrl?: string): string | null {
    const parts: string[] = [];

    // 引用消息：在前面附上被引用内容
    if (msg.quotedMessage) {
      const q = msg.quotedMessage;
      const qType = q.type ? `[${q.type}] ` : '';
      const qText = q.text || q.title || '';
      if (qText) parts.push(`[引用: ${qType}${qText.slice(0, 100)}]`);
    }

    // 主内容
    const type: string = msg.type ?? 'text';
    switch (type) {
      case 'text': {
        const text = (msg.text ?? '').trim();
        if (text) parts.push(text);
        break;
      }
      case 'image': {
        // 优先使用已下载的 base64 data URL，其次尝试 SDK 提供的 URL，最后降级
        const imgUrl = imageDataUrl ?? msg.images?.[0]?.url ?? '';
        parts.push(imgUrl ? `[发了一张图片: ${imgUrl}]` : '[发了一张图片]');
        if (msg.text && msg.text !== '[image]') parts.push(msg.text);
        break;
      }
      case 'voice': {
        // SDK 有时会提供语音转文字
        const voiceText = msg.voices?.[0]?.text;
        if (voiceText) {
          parts.push(`[语音消息: ${voiceText}]`);
        } else {
          const durationSec = msg.voices?.[0]?.durationMs
            ? Math.round(msg.voices[0].durationMs / 1000)
            : undefined;
          parts.push(durationSec ? `[发了一条 ${durationSec}s 的语音消息]` : '[发了一条语音消息]');
        }
        break;
      }
      case 'file': {
        const fileName = msg.files?.[0]?.fileName ?? '未知文件';
        const size = msg.files?.[0]?.size;
        const sizeStr = size ? ` (${Math.round(size / 1024)}KB)` : '';
        parts.push(`[发了一个文件: ${fileName}${sizeStr}]`);
        break;
      }
      case 'video': {
        const duration = msg.videos?.[0]?.durationMs
          ? Math.round(msg.videos[0].durationMs / 1000)
          : undefined;
        parts.push(duration ? `[发了一段 ${duration}s 的视频]` : '[发了一段视频]');
        break;
      }
      default: {
        const fallback = (msg.text ?? '').trim();
        if (fallback) parts.push(fallback);
        else parts.push(`[收到了 ${type} 类型消息]`);
      }
    }

    const result = parts.join(' ').trim();
    return result || null;
  }

  /** 在终端渲染二维码 */
  private async renderQr(url: string): Promise<void> {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║  [WeChat] 请用微信扫描下方二维码登录  ║');
    console.log('╚══════════════════════════════════════╝');
    try {
      // 优先使用 qrcode-terminal 显示终端二维码
      const qrcodeTerminal = require('qrcode-terminal');
      qrcodeTerminal.generate(url, { small: true });
    } catch {
      // 降级：显示可点击链接
      console.log(`\n  🔗 扫码链接: ${url}\n`);
    }
  }
}
