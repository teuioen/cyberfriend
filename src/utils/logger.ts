/**
 * 日志工具
 * 支持控制台（带颜色）和文件（纯文本）双输出，支持按天轮转和自动清理
 */
import * as fs from 'fs';
import * as path from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private level: number = LEVELS.info;
  private fileStream: fs.WriteStream | null = null;

  setLevel(level: string): void {
    this.level = LEVELS[level as LogLevel] ?? LEVELS.info;
  }

  /** 初始化文件日志，写入指定目录（按日期轮转），并清理过期日志 */
  initFileLog(logDir: string, retentionDays = 30): void {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const logPath = path.join(logDir, `${today}.log`);
      this.fileStream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
      this.info(`[Logger] 日志文件: ${logPath}`);
      this.cleanOldLogs(logDir, retentionDays);
    } catch (e) {
      process.stderr.write(`[Logger] 无法初始化文件日志: ${e}\n`);
    }
  }

  /** 删除超过 retentionDays 天的日志文件 */
  private cleanOldLogs(logDir: string, retentionDays: number): void {
    try {
      const cutoff = Date.now() - retentionDays * 86400000;
      const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
      let removed = 0;
      for (const file of files) {
        const filePath = path.join(logDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed++;
        }
      }
      if (removed > 0) this.info(`[Logger] 已清理 ${removed} 个过期日志文件（保留 ${retentionDays} 天）`);
    } catch (e) {
      this.warn(`[Logger] 清理过期日志失败: ${e}`);
    }
  }

  debug(msg: string): void { this.log('debug', msg); }
  info(msg: string): void  { this.log('info', msg); }
  warn(msg: string): void  { this.log('warn', msg); }
  error(msg: string): void { this.log('error', msg); }

  /** 仅写入文件，不输出到控制台 */
  fileOnly(msg: string): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const plain = `[${ts}] ${msg}`;
    if (this.fileStream) {
      this.fileStream.write(plain + '\n');
    }
  }

  private log(level: LogLevel, msg: string): void {
    if (LEVELS[level] < this.level) return;

    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const plain = `[${ts}][${level.toUpperCase()}] ${msg}`;

    // 控制台输出（带颜色）
    const colors: Record<LogLevel, string> = {
      debug: '\x1b[90m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m'
    };
    const reset = '\x1b[0m';
    process.stderr.write(`${colors[level]}${plain}${reset}\n`);

    // 文件输出（纯文本，无ANSI）
    if (this.fileStream) {
      this.fileStream.write(plain + '\n');
    }
  }
}

export const logger = new Logger();
