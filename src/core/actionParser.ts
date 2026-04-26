/**
 * 行动标签解析器
 * 支持标准 XML 属性风格：
 *   <TAG attr="val"/>                    自闭合（无内容）
 *   <TAG attr="val">content</TAG>        带内容
 *   <TAG/>  <TAG>                        无属性自闭合
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
  private static xmlContentTagRe = /<([A-Z_]+)(?!:)([\s\S]*?)>([\s\S]*?)<\/\1>/g;
  // 自闭合：<TAG attrs/> 或 <TAG/>  （属性值可跨行）
  private static xmlSelfClosingRe = /<([A-Z_]+)(?!:)([\s\S]*?)\s*\/>/g;
  // XML 开放标签（已知标签，无内容无自闭合）：<TAG attr="val">
  private static xmlOpenTagRe = /<([A-Z_]+)((?:\s+[^>]*)?)>(?![\[{])/g;

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
    SHOP_LIST: '查询商店',
    SHOP_USE: '使用物品',   // 旧标签别名
    USE: '使用物品',
    GIVE: '赠送',
    NO_ACTION: '无动作',
    CURRENCY: '货币',
    ENABLE_TOOLS: '工具开关',
    SKILL: '技能',
  };

  static getTagName(tag: string): string {
    return ActionParser.TAG_NAMES[tag] || tag;
  }

  /** 解析标准 XML 属性字符串（空格分隔，支持引号值） */
  static parseXmlAttrs(attrStr: string): Record<string, string> {
    if (!attrStr?.trim()) return {};
    const params: Record<string, string> = {};
    // 支持 key="val"（含转义引号 \"）、key='val'（含 \'）、key=val（无引号）
    const re = /([a-zA-Z_]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'>\/]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrStr)) !== null) {
      const raw = m[2] ?? m[3] ?? m[4] ?? '';
      params[m[1]] = ActionParser.decodeAttrValue(raw);
    }
    return params;
  }

  /** 解码属性值：先解 XML 实体，再解 JSON 风格转义序列（\\n \\t \\\" 等） */
  static decodeAttrValue(s: string): string {
    // 先解 XML/HTML 实体
    let result = ActionParser.decodeXmlEntities(s);
    // 再解 JSON 风格转义（AI 有时混用）
    result = result
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    return result;
  }

  /** 解码 XML/HTML 实体（&lt; &gt; &amp; &quot; &apos; &#N; &#xN;） */
  static decodeXmlEntities(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  /** 解析 AI 响应，提取行动标签和可见文本 */
  static parse(text: string): ActionResult {
    const actions: ParsedAction[] = [];

    // ── 第一步：标准 XML 带内容标签 <TAG attrs>content</TAG> ──
    let cleaned = text.replace(ActionParser.xmlContentTagRe, (match, tag, attrStr, content) => {
      actions.push({
        tag: tag.toUpperCase(),
        params: ActionParser.parseXmlAttrs(attrStr),
        content: ActionParser.decodeXmlEntities(content.trim()),
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
