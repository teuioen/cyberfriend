/**
 * 工具调用系统 - 允许AI调用沙盒化工具（命令行/网络等）
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { ToolsConfig } from '../config/types';
import { logger } from '../utils/logger';
import { OpenAITool } from './ai';

export interface ToolResult {
  toolName: string;
  params: Record<string, string>;
  output: string;
  error?: string;
}

const DEFAULT_CODING_PROMPT = `【编码准则】
- 修改文件前必须先用 read_file 读取完整内容，确认当前状态后再操作
- 编辑时保持精准：只改需要改的部分，不影响无关代码
- 使用 list_files/glob_files/grep_files 了解项目结构，避免盲目修改
- 文件较大时先 grep_files 定位目标行，再 read_file 确认上下文
- 执行 shell 命令时注意副作用，破坏性操作（rm、覆盖等）须谨慎
- 遇到错误时：先读取出错的文件，理解问题后再重试，不要盲目重试
- 每次工具调用完成后简要说明做了什么、下一步计划`;

export class ToolEngine {
  private enabledForSession = false;
  private workspace: string;
  private workspaceDisplay: string;
  private codingPrompt: string;

  constructor(readonly cfg: ToolsConfig) {
    this.workspace = path.resolve(process.cwd(), cfg.workspace ?? 'data/workspace');
    this.workspaceDisplay = cfg.workspace ?? 'data/workspace';
    if (this.cfg.enabled) {
      fs.mkdirSync(this.workspace, { recursive: true });
    }
    this.codingPrompt = this.loadCodingPrompt();
  }

  private loadCodingPrompt(): string {
    if (this.cfg.codingPromptFile) {
      try {
        const p = path.resolve(process.cwd(), this.cfg.codingPromptFile);
        return fs.readFileSync(p, 'utf-8').trim();
      } catch (e) {
        logger.warn(`[Tools] 无法读取 codingPromptFile: ${e}`);
      }
    }
    return DEFAULT_CODING_PROMPT;
  }

  /** 在当前对话中启用工具 */
  enableForSession(): void {
    this.enabledForSession = true;
    fs.mkdirSync(this.workspace, { recursive: true });
    logger.info('[Tools] 工具调用已在本次对话中启用');
  }

  /** 在当前对话中禁用工具（仅对会话级启用有效，不覆盖配置级 enabled） */
  disableForSession(): void {
    this.enabledForSession = false;
    logger.info('[Tools] 工具调用已在本次对话中禁用');
  }

  isEnabled(): boolean {
    return this.cfg.enabled || this.enabledForSession;
  }

  /** 调用指定工具，返回结果字符串 */
  async call(toolName: string, params: Record<string, string>): Promise<ToolResult> {
    if (!this.isEnabled()) {
      return { toolName, params, output: '', error: '工具系统未启用' };
    }
    logger.info(`[Tools] 调用工具: ${toolName}`);

    try {
      switch (toolName) {
        case 'shell':
          return this.runShell(params);
        case 'read_file':
          return this.readFile(params);
        case 'write_file':
          return this.writeFile(params);
        case 'edit_file':
          return this.editFile(params);
        case 'list_files':
          return this.listFiles(params);
        case 'glob_files':
          return this.globFiles(params);
        case 'grep_files':
          return this.grepFiles(params);
        case 'fetch':
          return await this.webFetch(params);
        default:
          return { toolName, params, output: '', error: `未知工具: ${toolName}` };
      }
    } catch (err: any) {
      logger.error(`[Tools] 工具执行错误: ${err.message}`);
      return { toolName, params, output: '', error: err.message };
    }
  }

  private runShell(params: Record<string, string>): ToolResult {
    if (!this.cfg.allowShell) {
      return { toolName: 'shell', params, output: '', error: '命令行工具未启用 (allowShell: false)' };
    }
    const cmd = params.cmd ?? params.command ?? '';
    if (!cmd) return { toolName: 'shell', params, output: '', error: '未提供命令 (cmd)' };
    try {
      const output = execSync(cmd, {
        cwd: this.workspace,
        timeout: this.cfg.shellTimeout ?? 10000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return { toolName: 'shell', params, output: output.trim() };
    } catch (err: any) {
      return { toolName: 'shell', params, output: err.stdout?.trim() ?? '', error: err.stderr?.trim() ?? err.message };
    }
  }

  private readFile(params: Record<string, string>): ToolResult {
    const filePath = params.path ?? params.file ?? '';
    if (!filePath) return { toolName: 'read_file', params, output: '', error: '未提供文件路径 (path)' };
    const fullPath = path.resolve(this.workspace, filePath);
    if (!fullPath.startsWith(this.workspace)) {
      return { toolName: 'read_file', params, output: '', error: '路径越界：只能访问工作区内文件' };
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    return { toolName: 'read_file', params, output: content };
  }

  private writeFile(params: Record<string, any>): ToolResult {
    const filePath = params.path ?? params.file ?? '';
    const raw = params.content ?? '';
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    if (!filePath) return { toolName: 'write_file', params, output: '', error: '未提供文件路径 (path)' };
    const fullPath = path.resolve(this.workspace, filePath);
    if (!fullPath.startsWith(this.workspace)) {
      return { toolName: 'write_file', params, output: '', error: '路径越界：只能在工作区内写入文件' };
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { toolName: 'write_file', params, output: `文件已写入: ${filePath}` };
  }

  private listFiles(params: Record<string, string>): ToolResult {
    const dir = params.path ?? params.dir ?? '.';
    const fullPath = path.resolve(this.workspace, dir);
    if (!fullPath.startsWith(this.workspace)) {
      return { toolName: 'list_files', params, output: '', error: '路径越界' };
    }
    const files = fs.readdirSync(fullPath);
    return { toolName: 'list_files', params, output: files.join('\n') };
  }

  private editFile(params: Record<string, string>): ToolResult {
    const filePath = params.path ?? params.file ?? '';
    const oldStr = params.old_str ?? params.old ?? '';
    const newStr = params.new_str ?? params.new ?? '';
    if (!filePath) return { toolName: 'edit_file', params, output: '', error: '未提供文件路径 (path)' };
    const fullPath = path.resolve(this.workspace, filePath);
    if (!fullPath.startsWith(this.workspace)) {
      return { toolName: 'edit_file', params, output: '', error: '路径越界' };
    }
    if (!fs.existsSync(fullPath)) return { toolName: 'edit_file', params, output: '', error: `文件不存在: ${filePath}` };
    const content = fs.readFileSync(fullPath, 'utf-8');
    if (!content.includes(oldStr)) return { toolName: 'edit_file', params, output: '', error: `未找到目标字符串 (old_str)，请先用 read_file 读取文件再重试` };
    fs.writeFileSync(fullPath, content.replace(oldStr, newStr), 'utf-8');
    return { toolName: 'edit_file', params, output: `已编辑 ${filePath}` };
  }

  private globFiles(params: Record<string, string>): ToolResult {
    const pattern = params.pattern ?? '*';
    try {
      const out = execSync(`find "${this.workspace}" -type f 2>/dev/null | head -200`, {
        timeout: 5000, encoding: 'utf-8',
      });
      const lines = out.trim().split('\n').filter(Boolean);
      // Simple glob filter: convert glob pattern to regex
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const re = new RegExp(escaped);
      const matched = lines
        .map(l => path.relative(this.workspace, l))
        .filter(l => re.test(l));
      return { toolName: 'glob_files', params, output: matched.join('\n') || '（无匹配文件）' };
    } catch {
      return { toolName: 'glob_files', params, output: '（工作区为空）' };
    }
  }

  private grepFiles(params: Record<string, string>): ToolResult {
    const pattern = params.pattern ?? params.query ?? '';
    if (!pattern) return { toolName: 'grep_files', params, output: '', error: '未提供搜索词 (pattern)' };
    const dir = params.path ? path.resolve(this.workspace, params.path) : this.workspace;
    if (!dir.startsWith(this.workspace)) return { toolName: 'grep_files', params, output: '', error: '路径越界' };
    try {
      const out = execSync(
        `grep -r --include="*" -n "${pattern.replace(/"/g, '\\"')}" "${dir}" 2>/dev/null | head -100`,
        { timeout: 5000, encoding: 'utf-8' },
      );
      return { toolName: 'grep_files', params, output: out.trim() || '（无匹配）' };
    } catch {
      return { toolName: 'grep_files', params, output: '（无匹配）' };
    }
  }

  private async webFetch(params: Record<string, string>): Promise<ToolResult> {
    if (!this.cfg.allowNet) {
      return { toolName: 'fetch', params, output: '', error: '网络访问未启用 (allowNet: false)' };
    }
    const url = params.url ?? '';
    if (!url) return { toolName: 'fetch', params, output: '', error: '未提供 URL (url)' };
    try {
      // Use Node built-in fetch (Node 18+) or fallback to https module
      const res = await fetch(url, { signal: AbortSignal.timeout(this.cfg.shellTimeout ?? 10000) } as RequestInit);
      const text = await res.text();
      return { toolName: 'fetch', params, output: text.slice(0, 4000) };
    } catch (err: any) {
      return { toolName: 'fetch', params, output: '', error: err.message };
    }
  }

  /** 返回工具的 OpenAI function calling 格式定义列表 */
  getOpenAITools(): OpenAITool[] {
    const tools: OpenAITool[] = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件内容',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: '创建或覆盖写入文件',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径' },
              content: { type: 'string', description: '文件内容' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description: '替换文件中第一处匹配的字符串',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径' },
              old_str: { type: 'string', description: '原始字符串' },
              new_str: { type: 'string', description: '新字符串' },
            },
            required: ['path', 'old_str', 'new_str'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: '列出工作区目录内容',
          parameters: {
            type: 'object',
            properties: {
              dir: { type: 'string', description: '相对工作区的目录路径，默认 "." 表示工作区根目录' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'glob_files',
          description: '匹配文件',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '如 *.txt、**/*.json' },
            },
            required: ['pattern'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'grep_files',
          description: '搜索文本内容',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '搜索词或正则表达式' },
              path: { type: 'string', description: '搜索的目录（可选）' },
            },
            required: ['pattern'],
          },
        },
      },
      ...(this.cfg.allowShell ? [{
        type: 'function' as const,
        function: {
          name: 'shell',
          description: '执行命令',
          parameters: {
            type: 'object' as const,
            properties: {
              cmd: { type: 'string', description: '命令' },
            },
            required: ['cmd'],
          },
        },
      }] : []),
      ...(this.cfg.allowNet ? [{
        type: 'function' as const,
        function: {
          name: 'fetch',
          description: '获取网页内容',
          parameters: {
            type: 'object' as const,
            properties: {
              url: { type: 'string', description: '网址' },
            },
            required: ['url'],
          },
        },
      }] : []),
    ];
    return tools;
  }

  getWorkspaceFiles(): string {
    if (!fs.existsSync(this.workspace)) return '';
    try {
      const entries = fs.readdirSync(this.workspace, { withFileTypes: true });
      const items = entries
        .slice(0, 50)
        .map(entry => '  ' + (entry.isDirectory() ? entry.name + '/' : entry.name));
      return items.join('\n');
    } catch { return ''; }
  }

  /** 格式化工具系统信息用于提示词（仅说明工作区，调用格式由 API tools 参数处理） */
  formatForPrompt(): string {
    if (!this.isEnabled()) return '';
    return `【工具系统】工作区路径: ${this.workspaceDisplay}（调用工具时路径参数均相对工作区根目录，用 "." 表示根目录）\n\n${this.codingPrompt}`;
  }
}
