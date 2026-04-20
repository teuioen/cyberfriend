/**
 * CLI 终端格式化工具
 * 提供 ANSI 颜色/样式帮助函数，用于美化命令行输出
 * 非 CLI 信道应通过 stripAnsi() 去除 ANSI 代码再发送
 */

// ── 基础样式 ──────────────────────────────
export const bold    = (s: string) => `\x1b[1m${s}\x1b[22m`;
export const dim     = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const italic  = (s: string) => `\x1b[3m${s}\x1b[23m`;

// ── 前景色 ────────────────────────────────
export const cyan    = (s: string) => `\x1b[36m${s}\x1b[39m`;
export const green   = (s: string) => `\x1b[32m${s}\x1b[39m`;
export const yellow  = (s: string) => `\x1b[33m${s}\x1b[39m`;
export const red     = (s: string) => `\x1b[31m${s}\x1b[39m`;
export const blue    = (s: string) => `\x1b[34m${s}\x1b[39m`;
export const magenta = (s: string) => `\x1b[35m${s}\x1b[39m`;
export const white   = (s: string) => `\x1b[97m${s}\x1b[39m`;

// ── 去除 ANSI（计算显示宽度时用）──────────
/** 去除所有 ANSI 转义序列（供非 CLI 信道使用）*/
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[mGKJ]/g, '');
}

/**
 * 转换为纯文本（供非 CLI 信道使用）：
 * 去除 ANSI 代码 + 盒子线条装饰字符，整理空行
 */
export function stripForPlainText(text: string): string {
  let result = stripAnsi(text);
  // 去除盒子/线条 Unicode 字符（U+2500–U+257F）
  result = result.replace(/[\u2500-\u257F]+/g, '');
  // 整理：去掉每行首尾空白，过滤纯空白行（保留最多一个连续空行）
  const lines = result.split('\n').map(l => l.trimEnd());
  const cleaned: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && prevBlank) continue;
    cleaned.push(line);
    prevBlank = blank;
  }
  return cleaned.join('\n').trim();
}

// ── 宽度计算 ──────────────────────────────
const getTerminalWidth = (): number =>
  Math.max(64, Math.min(120, (process.stdout as NodeJS.WriteStream & { columns?: number }).columns ?? 80));

/** 计算字符串的终端显示宽度（CJK/emoji 宽 2） */
const displayWidth = (s: string): number => {
  const plain = stripAnsi(s);
  let w = 0;
  for (const c of plain) {
    const cp = c.codePointAt(0) ?? 0;
    // ASCII 宽度 1；Latin extended (<0x300) 宽度 1；其余（CJK、emoji 等）宽度 2
    w += cp < 0x80 || (cp >= 0x80 && cp < 0x300) ? 1 : 2;
  }
  return w;
};

// ── 布局 ──────────────────────────────────

/** 子标题：── 节标题 ──── */
export const header = (text: string) => bold(cyan(`── ${text} `));

/**
 * 命令块标题栏（蓝色边框，自动根据终端宽度计算填充）
 * _icon 参数保留但不使用（兼容已有调用）
 */
export const titleBar = (title: string, _icon?: string): string => {
  const cols = getTerminalWidth();
  const inner = ` ${title} `;
  const dw = displayWidth(inner);
  const pad = Math.max(1, cols - dw - 4); // 4 = "╔═" + "╗"
  return `\n${bold(cyan(`╔═${inner}${'═'.repeat(pad)}╗`))}`;
};

/** 命令块底部边框（与 titleBar 等宽） */
export const divider = (_label?: string): string => {
  const cols = getTerminalWidth();
  return bold(cyan('╚' + '═'.repeat(cols - 2) + '╝'));
};

/** 以数值生成颜色（0-100：低=红 中=黄 高=绿） */
export function valueColor(val: number, text?: string): string {
  const s = text ?? String(val);
  if (val >= 70) return green(s);
  if (val >= 40) return yellow(s);
  return red(s);
}

/** 键值对行 */
export function kv(key: string, value: string, keyWidth = 18): string {
  return `  ${dim(key.padEnd(keyWidth))}  ${value}`;
}


