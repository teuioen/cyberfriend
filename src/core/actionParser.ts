/**
 * 行动标签解析器
 * 主要格式（标准 XML 属性风格）：
 *   <TAG attr="val"/>                    自闭合（无内容）
 *   <TAG attr="val">content</TAG>        带内容
 *   <TAG/>  <TAG>                        无属性自闭合
 * 兼容旧格式（降级解析，向后兼容）：
 *   <TAG:params>                         无内容旧式
 *   <TAG:params>[内容]                   带内容旧式（方括号）
 *   <TAG:params>{内容}                   带内容旧式（花括号）
 *   <TAG:params>内容</TAG>               带内容旧式（闭合）
 *   </TAG:params>                        关闭标签带参数（AI出错容错）
 */

export interface ParsedAction {
  tag: string;
  params: Record<string, string>;
  content?: string;
  rawText?: string;  // 原始标签文本（用于调试显示）
}

export interface ActionResult {
  actions: ParsedAction[];
  visibleText: string;
}

export class ActionParser {
  // ── 主要格式：标准 XML ──
  // 带内容：<TAG attrs>content</TAG>（排除旧式 <TAG:params>，用 (?!:) 区分）
  private static xmlContentTagRe = /<([A-Z_]+)(?!:)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g;
  // 自闭合：<TAG attrs/> 或 <TAG/>
  private static xmlSelfClosingRe = /<([A-Z_]+)(?!:)((?:\s[^>]*)?)\s*\/>/g;
  // XML 开放标签（已知标签，无内容无自闭合）：<TAG attr="val">
  private static xmlOpenTagRe = /<([A-Z_]+)((?:\s+[^>]*)?)>(?![\[{])/g;

  // ── 兼容旧格式（向后兼容降级） ──
  // 带内容（方括号/花括号）：<TAG:params>[content] 或 {content}
  private static oldContentTagRe = /<([A-Z_]+)(?::([^>]*))?>(\[[\s\S]*?\]|\{[\s\S]*?\})/g;
  // 旧式闭合标签：<TAG:params>content</TAG>
  private static oldLegacyTagRe = /<([A-Z_]+)(?::([^>]*))?>([^]*?)<\/\1>/g;
  // 旧式无内容（不跟 [ 或 {）：<TAG:params>、<TAG>、<TAG/>
  private static oldSelfTagRe = /<([A-Z_]+)(?::([^>]*?))?\/?>(?![\[{])/g;
  // 容错：关闭标签带参数 </TAG:params>
  private static closeTagWithParamsRe = /<\/([A-Z_]+):([^>]*)>/g;

  // 可携带文本内容的标签
  private static CONTENT_TAGS = new Set([
    'MEMORY_SAVE', 'MEMORY_ADD', 'MEMORY_UPDATE',
    'DIARY_WRITE', 'SEND_MESSAGE', 'TASK_CREATE',
  ]);

  // 标签中文名映射
  private static TAG_NAMES: Record<string, string> = {
    EMOTION: '情绪',
    MEMORY_SAVE: '记忆存储',
    MEMORY_ADD: '记忆存储',
    MEMORY_UPDATE: '记忆更新',
    MEMORY_DELETE: '记忆删除',
    MEMORY_RECALL: '记忆检索',
    HEALTH: '健康',
    AFFECTION: '亲密度',
    MOOD: '心情',
    DIARY_WRITE: '日记',
    DIARY_READ: '翻阅日记',
    NEWS_CHECK: '查看新闻',
    SCHEDULE_EVENT: '日程事件',
    SEND_MESSAGE: '发送消息',
    SLEEP: '睡眠',
    DREAM: '梦境',
    WORK_START: '打工',
    TASK_CREATE: '创建任务',
    TASK_COMPLETE: '完成任务',
    SILENT: '沉默',
    BLACKLIST: '拉黑',
    UNBLACKLIST: '解除拉黑',
    NEXT_HEARTBEAT: '心跳间隔',
    SHOP_BUY: '购物',
    SHOP_USE: '使用物品',
    GIVE: '赠送',
    NO_ACTION: '无动作',
  };

  static getTagName(tag: string): string {
    return ActionParser.TAG_NAMES[tag] || tag;
  }

  /** 解析标准 XML 属性字符串（空格分隔，支持引号值） */
  static parseXmlAttrs(attrStr: string): Record<string, string> {
    if (!attrStr?.trim()) return {};
    const params: Record<string, string> = {};
    // 支持 key="val"、key='val'、key=val（无引号）
    const re = /([a-zA-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^\s"'>\/]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrStr)) !== null) {
      params[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return params;
  }

  /** 解析旧格式参数字符串（逗号分隔 param1=val1,param2=val2） */
  static parseParams(paramStr: string): Record<string, string> {
    if (!paramStr?.trim()) return {};
    const params: Record<string, string> = {};
    const re = /([a-zA-Z_]+)=("([^"]*)"|([^,]*))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(paramStr)) !== null) {
      params[m[1]] = m[3] !== undefined ? m[3] : (m[4] ?? '').trim();
    }
    return params;
  }

  /** 解析 AI 响应，提取行动标签和可见文本 */
  static parse(text: string): ActionResult {
    const actions: ParsedAction[] = [];

    // ── 第一步：标准 XML 带内容标签 <TAG attrs>content</TAG> ──
    let cleaned = text.replace(ActionParser.xmlContentTagRe, (match, tag, attrStr, content) => {
      actions.push({
        tag: tag.toUpperCase(),
        params: ActionParser.parseXmlAttrs(attrStr),
        content: content.trim(),
        rawText: match,
      });
      return '';
    });

    // ── 第二步：标准 XML 自闭合 <TAG attrs/> ──
    cleaned = cleaned.replace(ActionParser.xmlSelfClosingRe, (match, tag, attrStr) => {
      actions.push({
        tag: tag.toUpperCase(),
        params: ActionParser.parseXmlAttrs(attrStr),
        rawText: match,
      });
      return '';
    });

    // ── 第2.5步：XML 开放标签（已知标签，无内容/闭合）<TAG attr="val"> ──
    cleaned = cleaned.replace(ActionParser.xmlOpenTagRe, (match, tag, attrStr) => {
      const tagUpper = tag.toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(ActionParser.TAG_NAMES, tagUpper)) return match;
      actions.push({
        tag: tagUpper,
        params: ActionParser.parseXmlAttrs(attrStr),
        rawText: match,
      });
      return '';
    });

    // ── 第三步：旧格式带内容（方括号/花括号）<TAG:params>[content] ──
    cleaned = cleaned.replace(ActionParser.oldContentTagRe, (match, tag, paramStr, bracketed) => {
      actions.push({
        tag: tag.toUpperCase(),
        params: ActionParser.parseParams(paramStr ?? ''),
        content: bracketed.slice(1, -1).trim(),
        rawText: match,
      });
      return '';
    });

    // ── 第四步：旧格式闭合标签 <TAG:params>content</TAG> ──
    cleaned = cleaned.replace(ActionParser.oldLegacyTagRe, (match, tag, paramStr, content) => {
      actions.push({
        tag: tag.toUpperCase(),
        params: ActionParser.parseParams(paramStr ?? ''),
        content: content.trim(),
        rawText: match,
      });
      return '';
    });

    // ── 第4.5步：容错 - 末尾未闭合内容型标签 ──
    cleaned = cleaned.replace(
      /<([A-Z_]+)(?::([^>]*))?\s*>((?:(?!<[A-Z_]+(?::[^>]*)?>)[\s\S])+)\s*$/,
      (match, tag, paramStr, content) => {
        if (!ActionParser.CONTENT_TAGS.has(tag.toUpperCase())) return match;
        actions.push({
          tag: tag.toUpperCase(),
          params: ActionParser.parseParams(paramStr ?? ''),
          content: content.trim(),
          rawText: match,
        });
        return '';
      });

    // ── 第五步：旧格式无内容 <TAG:params>、<TAG> ──
    cleaned = cleaned.replace(ActionParser.oldSelfTagRe, (match, tag, paramStr) => {
      actions.push({
        tag: tag.toUpperCase(),
        params: ActionParser.parseParams(paramStr ?? ''),
        rawText: match,
      });
      return '';
    });

    // ── 第六步：容错 - 关闭标签带参数 </TAG:params> ──
    cleaned = cleaned.replace(ActionParser.closeTagWithParamsRe, (match, tag, paramStr) => {
      actions.push({
        tag: tag.toUpperCase(),
        params: ActionParser.parseParams(paramStr ?? ''),
        rawText: match,
      });
      return '';
    });

    // 清理孤立关闭标签
    cleaned = cleaned.replace(/<\/[A-Z][A-Z_]*>/g, '');

    return {
      actions,
      visibleText: cleaned.trim(),
    };
  }

  /** 将消息按 | 分割为多条（用于模拟真实发送） */
  static splitMessages(text: string): string[] {
    const seen = new Set<string>();
    const parts = text.includes('|') ? text.split('|') : text.split(/\n{2,}/);
    return parts
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .filter(s => {
        const normalized = s.replace(/\s+/g, ' ');
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      });
  }

  /** 剥离文本中所有行动标签，只保留可见文字 */
  static stripAll(text: string): string {
    // 标准 XML 带内容
    let result = text.replace(/<([A-Z_]+)(?!:)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g, '');
    // 标准 XML 自闭合
    result = result.replace(/<([A-Z_]+)(?!:)((?:\s[^>]*)?)\s*\/>/g, '');
    // 旧格式带内容（方括号/花括号）
    result = result.replace(/<([A-Z_]+)(?::([^>]*))?>(\[[\s\S]*?\]|\{[\s\S]*?\})/g, '');
    // 旧格式闭合标签
    result = result.replace(/<([A-Z_]+)(?::([^>]*))?>([^]*?)<\/\1>/g, '');
    // 旧格式末尾未闭合（仅内容型标签）
    result = result.replace(
      /<([A-Z_]+)(?::([^>]*))?\s*>((?:(?!<[A-Z_]+(?::[^>]*)?>)[\s\S])+)\s*$/,
      (_m, tag, _p, _c) => ActionParser.CONTENT_TAGS.has(tag.toUpperCase()) ? '' : _m,
    );
    // 旧格式无内容
    result = result.replace(/<([A-Z_]+)(?::([^>]*?))?\/?>(?![\[{])/g, '');
    // 关闭标签带参数
    result = result.replace(/<\/([A-Z_]+):([^>]*)>/g, '');
    // 普通关闭标签
    result = result.replace(/<\/[A-Z][A-Z_]*>/g, '');
    return result.trim();
  }

  /** 解析数值 delta，支持 "+5", "-3", "5" */
  static parseDelta(val: string): number {
    if (!val) return 0;
    return parseFloat(val);
  }

  /** Debug 模式：输出原始标签文本（青色） */
  static formatForDebug(actions: ParsedAction[]): string {
    const CYAN = '\x1b[36m';
    const RESET = '\x1b[0m';
    if (!actions.length) return '';
    return actions.map(a => `${CYAN}${a.rawText ?? `<${a.tag}/>`}${RESET}`).join('\n');
  }

  /** 非 Debug 模式：原始标签+中文名，仅写入日志文件 */
  static formatForDebugLog(actions: ParsedAction[]): string {
    if (!actions.length) return '';
    return actions.map(a => {
      const tagName = ActionParser.getTagName(a.tag);
      const rawText = a.rawText ?? `<${a.tag}/>`;
      return `✨ ${tagName}: ${rawText}`;
    }).join('\n');
  }
}
