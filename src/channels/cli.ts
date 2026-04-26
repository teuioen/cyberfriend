/**
 * CLI 信道实现
 * 通过命令行进行交互，支持 /命令 语法
 */
import * as readline from 'readline';
import { BaseChannel, SendOptions } from './base';
import { logger } from '../utils/logger';

export class CLIChannel extends BaseChannel {
  readonly name = 'CLI';
  protected logOutgoing = false;  // CLI 直接打印消息，不需要重复 logger
  private rl?: readline.Interface;
  private running = false;
  private isSendingBatch = false;
  private insideLineHandler = false;  // 当在 rl.on('line') 上下文中时，send方法不自动显示提示符

  // 处理中计时器
  private processingTimer?: NodeJS.Timeout;
  private processingStart = 0;

  // 角色名（显示用）
  private charName = 'Ta';

  // 上次显示时间分割线的时间（0 = 从未显示，首次必定触发）
  private lastTimeMarkerTime = 0;
  private timeMarkerIntervalMs = 5 * 60 * 1000;  // 5分钟显示一次时间分割线

  // 当前批次已发送消息数（用于决定首条消息是否加空行前缀）
  private batchMessageCount = 0;

  // 命令注册表（备用，实际已通过 messageHandler 统一分发）
  private commands: Map<string, (args: string[]) => Promise<string | void>> = new Map();

  // ESC 键中断机制
  private escPressCount = 0;
  private escPressTimeout?: NodeJS.Timeout;
  private abortController?: AbortController;
  private onRequestAbort?: () => boolean;

  constructor() {
    super();
    // 立即接管 console.log/info，防止之后启动的 wechat/qq 等第三方库日志覆盖 readline 输入框
    this.patchConsole();
  }

  registerCommand(name: string, handler: (args: string[]) => Promise<string | void>): void {
    this.commands.set(name.toLowerCase(), handler);
  }

  /** 设置角色名（在启动前调用） */
  setCharacterName(name: string): void {
    this.charName = name;
  }

  /** 更新并显示提示符（使用 readline 标准接口，避免闪烁/重复） */
  private showPrompt(): void {
    if (!this.running || !this.rl) return;
    this.rl.setPrompt(`\x1b[32m>\x1b[0m `);
    this.rl.prompt(true);
  }

  /** 显示时间分割线（如果距离上次显示超过了间隔） */
  showTimeMarkerIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastTimeMarkerTime >= this.timeMarkerIntervalMs) {
      const d = new Date(now);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      const timestamp = `${year}-${month}-${day} ${hours}:${minutes}`;
      this.writeLine(`\x1b[2m━━ ${timestamp} ━━\x1b[0m`);
      this.lastTimeMarkerTime = now;
    }
  }

  /** readline 安全写一行：清除当前行 → 输出 → 重显提示符 */
  writeLine(text: string): void {
    if (!this.rl) {
      process.stdout.write(text + '\n');
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(text + '\n');
    // 非批量发送且非命令处理期间且无指示器时，重新显示输入提示符
    if (this.running && !this.isSendingBatch && !this.insideLineHandler && !this.processingTimer) {
      this.rl.prompt(true);
    }
  }

  /** 劫持 console.log / console.info / process.stderr.write，使第三方库输出也走 readline 安全路径 */
  private patchConsole(): void {
    const safe = (text: string) => {
      // 去掉末尾换行，writeLine 自己会加
      this.writeLine(text.replace(/\n$/, ''));
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.log = (...args: any[]) => safe(args.map((a) => String(a)).join(' '));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.info = (...args: any[]) => safe(args.map((a) => String(a)).join(' '));

    // 劫持 process.stderr.write：@wechatbot/wechatbot 的日志直接写 stderr
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any, encodingOrCb?: any, cb?: any): boolean => {
      // 只处理字符串/Buffer，其他类型直接透传
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        // 若 rl 已初始化，走 readline 安全路径；否则直接透传 stderr
        if (this.rl) {
          safe(text);
          const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
          if (callback) callback();
          return true;
        }
      }
      // rl 未就绪或非文本，直接透传原始 stderr
      return origStderrWrite(chunk, encodingOrCb as any, cb as any);
    };
  }

  async start(): Promise<void> {
    this.running = true;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    this.writeLine('\n╔════════════════════════════════╗');
    this.writeLine(`║   CyberFriend 赛博朋友         ║`);
    // 角色名用冰蓝色显示，用「」包起来
    const iceBlue = '\x1b[38;2;120;210;255m';
    const reset = '\x1b[0m';
    const charNameDisplay = `「${iceBlue}${this.charName}${reset}」`;
    const padding = Math.max(0, 16 - this.charName.length);  // 调整填充以对齐
    const charNameLine = `║   角色：${charNameDisplay}${' '.repeat(padding)}║`;
    this.writeLine(charNameLine);
    this.writeLine('║                                ║');
    this.writeLine('║   输入 /help 查看可用命令      ║');
    this.writeLine('║   输入 /quit 退出系统          ║');
    this.writeLine('╚════════════════════════════════╝\n');

    // 监听 ESC 键（双按中断 AI 请求）
    process.stdin.on('data', (key) => {
      // ESC 键的字节码是 0x1b (27)，通常单独出现或跟随特殊序列
      // 纯 ESC 键（不含其他字符）才算一次按压
      if (key.length === 1 && key[0] === 0x1b) {
        this.escPressCount++;
        // 清除之前的超时
        if (this.escPressTimeout) clearTimeout(this.escPressTimeout);
        // 设置 500ms 的超时，期间如果再按一次就触发中断
        this.escPressTimeout = setTimeout(() => {
          this.escPressCount = 0;
        }, 500);
        
        if (this.escPressCount === 2) {
          this.escPressCount = 0;
          if (this.escPressTimeout) clearTimeout(this.escPressTimeout);
          if (this.onRequestAbort) {
            // 仅当真的中止了请求时才输出消息
            if (this.onRequestAbort()) {
              this.writeLine('\n\x1b[33m⚠️ 已中止请求\x1b[0m');
            }
          }
        }
      } else {
        // 非纯 ESC 键，重置计数（防止其他输入累积）
        this.escPressCount = 0;
      }
    });

    this.rl.on('line', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        this.showPrompt();
        return;
      }

      this.insideLineHandler = true;
      try {
        if (trimmed.startsWith('/')) {
          await this.handleCommand(trimmed);
        } else {
          if (this.messageHandler) {
            await this.messageHandler(trimmed);
          }
        }
      } finally {
        this.insideLineHandler = false;
        this.showPrompt();
      }
    });

    this.rl.on('close', () => {
      this.running = false;
    });

    this.showPrompt();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.rl?.close();
  }

  /** CLI专用：去掉AI误加的时间戳前缀（句号已由基类清理） */
  protected cleanText(text: string): string {
    text = super.cleanText(text);
    text = text.replace(/^\[\d{1,2}:\d{2}(:\d{2})?\]\s*/u, '').trim();
    return text;
  }

  async sendMessage(text: string, _options?: SendOptions): Promise<void> {
    // 仅在非批量模式下才单独显示时间分割线（批量时由 beforeBatch 统一处理）
    if (!this.isSendingBatch) {
      this.showTimeMarkerIfNeeded();
    }
    // 批次第一条消息直接替换 💬 指示符（无空行前缀）；后续消息加空行分隔
    const prefix = (this.isSendingBatch && this.batchMessageCount === 0) ? '' : '\n';
    if (this.isSendingBatch) this.batchMessageCount++;
    this.writeLine(`${prefix}\x1b[36m${this.charName}\x1b[0m: ${text}`);
  }

  async sendNotice(text: string): Promise<void> {
    this.writeLine(`\n\x1b[33m${text}\x1b[0m`);
  }

  /** 批量发送前：标记批次开始，显示时间分割线，切换为"正在输入中..." */
  protected beforeBatch(): void {
    this.isSendingBatch = true;
    this.batchMessageCount = 0;
    this.showTimeMarkerIfNeeded();
    this.startProcessing();
  }

  /** 批量发送后：结束批次，清除"正在输入中..."，恢复输入提示符 */
  protected afterBatch(): void {
    this.isSendingBatch = false;
    this.stopProcessing();
    if (!this.insideLineHandler) this.showPrompt();
  }

  /** 显示"等待中"动态计时（AI 请求发出后、收到回复前）*/
  startWaiting(): void {
    this.stopProcessing(); // 清除旧计时器（防重复）
    this.processingStart = Date.now();
    const writeWait = () => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write('\x1b[2m⏳ 等待中...\x1b[0m');
    };
    writeWait();
    // 延迟一个微任务：确保在 readline 的 _refreshLine() 重绘提示符后，我们的指示器仍然显示
    this.processingTimer = setInterval(() => {
      const secs = ((Date.now() - this.processingStart) / 1000).toFixed(1);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`\x1b[2m⏳ 等待中... (${secs}s)\x1b[0m`);
    }, 200);
    queueMicrotask(() => { if (this.processingTimer) writeWait(); });
  }

  /** 显示"正在输入中"动态计时（收到回复后、发送消息前）*/
  startProcessing(): void {
    this.stopProcessing(); // 清除旧计时器（防重复）
    this.processingStart = Date.now();
    const writeProc = () => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write('\x1b[2m💬 正在输入中...\x1b[0m');
    };
    // 不用 writeLine（不加换行），这样计时器可以在同一行原地覆盖更新
    writeProc();
    this.processingTimer = setInterval(() => {
      const secs = ((Date.now() - this.processingStart) / 1000).toFixed(1);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`\x1b[2m💬 正在输入中... (${secs}s)\x1b[0m`);
    }, 200);
    queueMicrotask(() => { if (this.processingTimer) writeProc(); });
  }

  /** 清除"处理中"提示 */
  stopProcessing(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = undefined;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }

  /** 注册请求中断处理器，返回 true 表示真的中止了请求 */
  setRequestAbortHandler(handler: () => boolean): void {
    this.onRequestAbort = handler;
  }

  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
      console.log('\n再见！👋');
      process.exit(0);
    }

    // 将所有命令转发给主消息处理器（确保 CommandResult/AI触发等逻辑正确执行）
    if (this.messageHandler) {
      await this.messageHandler(input);
    } else {
      this.writeLine(`\x1b[31m未知命令: /${cmd}，输入 /help 查看帮助\x1b[0m`);
    }
    // 提示符由 rl.on('line') 的 finally 块统一显示，此处不重复调用
  }
}
