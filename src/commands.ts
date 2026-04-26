import { Database } from './database/db';
import { EmotionSystem } from './systems/emotion';
import { MemorySystem } from './systems/memory';
import { HealthSystem } from './systems/health';
import { RelationshipSystem } from './systems/relationship';
import { DiarySystem } from './systems/diary';
import { SleepSystem } from './systems/sleep';
import { WorkSystem } from './systems/work';
import { UserWorkSystem } from './systems/userWork';
import { NewsSystem } from './systems/news';
import { TaskScheduler } from './systems/scheduler';
import { AIClient } from './core/ai';
import { ActionParser } from './core/actionParser';
import { ContextManager } from './core/context';
import { PromptBuilder } from './core/promptBuilder';
import { HeartbeatManager } from './core/heartbeat';
import { ShopSystem } from './systems/shop';
import { WeatherSystem } from './systems/weather';
import { IChannel } from './channels/base';
import { logger } from './utils/logger';
import { formatCurrentTime } from './utils/time';
import { countTextTokens, countMessagesTokens } from './utils/tokens';
import { bold, cyan, green, yellow, red, dim, magenta, white, header, kv, valueColor, titleBar, divider } from './utils/cliFormat';


/** 命令返回值：纯字符串通知，或带有可选 AI 触发事件的对象 */
export interface CommandResult {
  notice?: string;      // 显示给用户的确认文字（不经过AI）
  triggerEvent?: string; // 注入上下文并触发AI即时响应的事件描述
}

interface Systems {
  db: Database;
  emotionSys: EmotionSystem;
  healthSys: HealthSystem;
  memorySys: MemorySystem;
  relSys: RelationshipSystem;
  diarySys: DiarySystem;
  sleepSys: SleepSystem;
  newsSys: NewsSystem;
  scheduler: TaskScheduler;
  heartbeat: HeartbeatManager;
  shopSys: ShopSystem;
  character: { name: string };
  promptBuilder: PromptBuilder;
  contextMgr: ContextManager;
  userWorkSys: UserWorkSystem;
  workSys: WorkSystem;
  weatherSys: WeatherSystem;
  ai: AIClient;
  debugMode: boolean;
}

export const commandRegistry = new Map<string, (args: string[]) => Promise<string | CommandResult | void>>();

export function addCommand(name: string, handler: (args: string[]) => Promise<string | CommandResult | void>): void {
  commandRegistry.set(name.toLowerCase(), handler);
}

export function registerCommands(add: (name: string, handler: (args: string[]) => Promise<string | CommandResult | void>) => void, sys: Systems): void {
  const { db, emotionSys, healthSys, memorySys, relSys,
          diarySys, sleepSys, newsSys, scheduler, heartbeat, shopSys,
          promptBuilder, contextMgr, userWorkSys, workSys, weatherSys, ai, debugMode } = sys;

  // /status
  add('status', async () => {
    const healthState = healthSys.getState();
    const rel = relSys.getState();
    const sleeping = sleepSys.isAsleep();
    const working = workSys.isWorking();
    const weather = weatherSys.getWeather();

    const healthVal = Math.round(healthState.healthValue);
    const fatigueVal = Math.round(healthState.fatigue);
    const hungerVal = Math.round((healthState as any).hunger ?? 80);
    const affVal = Math.round(rel.affection);
    const affLabel = affVal >= 80 ? '挚友' : affVal >= 60 ? '好友' : affVal >= 40 ? '普通朋友' : affVal >= 20 ? '泛泛之交' : '陌生人';

    const diseaseStr = healthState.disease
      ? `\n  ${yellow('⚠️  患病:')} ${healthState.disease}（剩余约 ${healthState.diseaseDuration}h）` : '';
    const psychStr = healthState.psychologyState && healthState.psychologyState !== 'normal'
      ? `\n  ${magenta('🧠 心理:')} ${healthState.psychologyState}` : '';

    let activityStr = '';
    if (sleeping) {
      const wakeTime = sleepSys.getWakeTime();
      const wakeDesc = sleepSys.getWakeUpDescription();
      const wakeTimeStr = wakeTime
        ? `预计 ${wakeTime.getHours().toString().padStart(2,'0')}:${wakeTime.getMinutes().toString().padStart(2,'0')} 醒来`
        : '';
      activityStr = `\n  ${cyan('💤 睡眠中')} ${dim(wakeTimeStr ? `${wakeTimeStr}（${wakeDesc}）` : wakeDesc)}`;
    } else if (working) {
      const endTime = workSys.getEndTime();
      const workDesc = workSys.getWorkDescription();
      const endTimeStr = endTime
        ? `预计 ${endTime.getHours().toString().padStart(2,'0')}:${endTime.getMinutes().toString().padStart(2,'0')} 结束`
        : '';
      activityStr = `\n  ${yellow('💼 打工中')} ${dim(endTimeStr ? `${endTimeStr}（${workDesc}）` : workDesc)}`;
    }

    const weatherStr = weather
      ? `\n  ${dim('🌤️  天气:')} ${weather.city} ${weather.description} ${weather.temp}°C 湿度${weather.humidity}%`
      : '';

    return [
      titleBar('Ta 当前状态', '♡'),
      kv('🕐 时间', formatCurrentTime()),
      '',
      `  ${header('情绪')}`,
      `    ${emotionSys.toFullString()}`,
      `    ${dim('主导:')} ${bold(emotionSys.getMoodTag())}`,
      '',
      `  ${header('健康')}`,
      kv('❤️  健康', `${valueColor(healthVal, String(healthVal))} / 100`),
      kv('😴 疲惫', `${valueColor(100 - fatigueVal, String(fatigueVal))} / 100`),
      kv('🍽️  饥饿', `${valueColor(hungerVal, String(hungerVal))} / 100`),
      diseaseStr,
      psychStr,
      '',
      `  ${header('关系')}`,
      kv('💕 好感', `${valueColor(affVal, String(affVal))} / 100  ${dim(affLabel)}`),
      kv('💰 余额', `我: ${yellow(String(Math.round(rel.aiCurrency)))}  你: ${dim(String(Math.round(rel.userCurrency)))}`),
      activityStr,
      weatherStr,
      divider(),
    ].filter(l => l !== '').join('\n');
  });

  // /view_diary [date]
  // /view_diary [日期|u|d|页码|s 关键词]  — 查看日记，支持翻页与搜索
  let diaryPage = 1;
  add('view_diary', async (args) => {
    const arg = args[0] ?? '';
    const pageSize = 3;

    const fmtDiaries = (entries: any[]) => entries.map(e => {
      const d = new Date(e.createdAt);
      const timeStr = `${e.date} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      const mood = e.mood ? ` ${dim(`[${e.mood}]`)}` : '';
      return `  ${bold(cyan(timeStr))}${mood}\n${e.content.split('\n').map((l: string) => '  ' + l).join('\n')}`;
    }).join('\n\n' + dim('─'.repeat(40)) + '\n\n');

    if ((arg === 's' || arg === 'search') && args.slice(1).length > 0) {
      const keyword = args.slice(1).join(' ');
      const results = diarySys.search(keyword, 10);
      if (!results.length) return dim(`（没有找到包含「${keyword}」的日记）`);
      return `\n${bold(cyan(`🔍 日记搜索：「${keyword}」`))} ${dim(`(${results.length}条)`)}\n\n${fmtDiaries(results)}`;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      const entries = diarySys.get(arg);
      if (!entries.length) return dim(`（${arg} 没有日记）`);
      return `\n${bold(cyan(`📔 ${arg} 的日记`))}\n\n${fmtDiaries(entries)}`;
    }

    if (arg === 'u') {
      diaryPage = Math.max(1, diaryPage - 1);
    } else if (arg === 'd') {
      diaryPage += 1;
    } else if (arg && /^\d+$/.test(arg)) {
      diaryPage = parseInt(arg, 10) || 1;
    }

    const { entries, total, page: curPage, totalPages } = diarySys.getPage(diaryPage, pageSize);
    diaryPage = curPage;

    if (!entries.length) return dim('（还没有写过日记）');
    const prev = curPage > 1 ? green('/view_diary u') : '';
    const next = curPage < totalPages ? green('/view_diary d') : '';
    const navParts = [prev && `← ${prev}`, next && `${next} →`].filter(Boolean);
    const nav = dim(`第 ${curPage}/${totalPages} 页，共 ${total} 篇`) + (navParts.length ? `  ${navParts.join(dim(' | '))}` : '');
    return [
      titleBar('日记', '📔'),
      `  ${nav}`,
      '',
      fmtDiaries(entries),
      divider(),
    ].join('\n');
  });

  // /memories [all | <page> | <count> | search <关键词>]
  add('memories', async (args) => {
    const PAGE_SIZE = 10;
    const importanceColor = (n: number) => n >= 8 ? red(String(n)) : n >= 5 ? yellow(String(n)) : dim(String(n));
    const fmtMem = (m: any) => `  ${dim(`#${m.id}`)} ${dim(`[重要度:`)}${importanceColor(m.importance)}${dim(']')} ${m.content}`;

    if (args[0] === 'search' && args.slice(1).length > 0) {
      const query = args.slice(1).join(' ');
      const results = memorySys.recall(query, 20);
      if (!results.length) return dim(`（没有找到与"${query}"相关的记忆）`);
      return `\n${bold(cyan(`🔍 记忆搜索: "${query}"`))}  ${dim(`找到 ${results.length} 条`)}\n` +
        results.map(m => `  ${dim(`#${m.id}`)} ${dim('[' + m.level + '/重要度:')}${importanceColor(m.importance)}${dim(']')} ${m.content}`).join('\n') + '\n';
    }

    // /memories all — 显示所有记忆（分类）
    if (args[0] === 'all') {
      const perm = memorySys.getPermanentMemories();
      const long = db.getMemories('long');
      const short = db.getMemories('short');
      const fmtSection = (mems: any[], icon: string, label: string) => {
        if (!mems.length) return `\n  ${header(icon + ' ' + label)} ${dim('（空）')}`;
        return `\n  ${header(icon + ' ' + label)}\n` + mems.map(fmtMem).join('\n');
      };
      return [
        titleBar('记忆库（全部）', '🧠'),
        fmtSection(perm, '🔒', `永久记忆 (${perm.length})`),
        fmtSection(long, '📚', `长期记忆 (${long.length})`),
        fmtSection(short, '💬', `短期记忆 (${short.length})`),
        `\n  ${dim('提示: /memories <页码> | /memories search <关键词>')}`,
        divider(),
      ].join('\n');
    }

    // /memories <数字> — 按页码或条数显示
    const numArg = args[0] ? parseInt(args[0], 10) : NaN;
    if (!isNaN(numArg) && numArg > 0) {
      const allMems = [
        ...memorySys.getPermanentMemories(),
        ...db.getMemories('long'),
        ...db.getMemories('short'),
      ];
      const page = numArg;
      const start = (page - 1) * PAGE_SIZE;
      const slice = allMems.slice(start, start + PAGE_SIZE);
      const totalPages = Math.ceil(allMems.length / PAGE_SIZE);
      if (!slice.length) return dim(`（第 ${page} 页没有记忆，共 ${totalPages} 页）`);
      return [
        titleBar(`记忆库 第 ${page}/${totalPages} 页`, '🧠'),
        slice.map(m => `  ${dim(`#${m.id}`)} ${dim(`[${m.level}/重要度:`)}${importanceColor(m.importance)}${dim(']')} ${m.content}`).join('\n'),
        `\n  ${dim(`共 ${allMems.length} 条 · /memories <页码> 翻页 | /memories all 查看全部`)}`,
        divider(),
      ].join('\n');
    }

    // 默认：分类显示前 PAGE_SIZE 条
    const perm = memorySys.getPermanentMemories();
    const long = db.getMemories('long').slice(0, 8);
    const short = db.getMemories('short').slice(0, 5);

    const fmtSection = (mems: any[], icon: string, label: string) => {
      if (!mems.length) return `\n  ${header(icon + ' ' + label)} ${dim('（空）')}`;
      return `\n  ${header(icon + ' ' + label)}\n` + mems.map(fmtMem).join('\n');
    };

    return [
      titleBar('记忆库', '🧠'),
      fmtSection(perm, '🔒', '永久记忆'),
      fmtSection(long, '📚', `长期记忆（最近8条）`),
      fmtSection(short, '💬', `短期记忆（最近5条）`),
      `\n  ${dim('提示: /memories all 查全部 | /memories <页码> | /memories search <关键词>  #号为记忆ID')}`,
      divider(),
    ].join('\n');
  });

  // /dreams
  add('dreams', async () => {
    const dreams = sleepSys.getRecentDreams(3);
    if (!dreams.length) return dim('（还没有梦境记录）');
    const typeIcon: Record<string, string> = {
      sweet: '🌸 美梦', nightmare: '😱 噩梦', weird: '🌀 奇异梦', neutral: '💭 梦境'
    };
    return [
      titleBar('梦境记录', '✨'),
      ...dreams.map(d => {
        const date = new Date(d.createdAt).toLocaleDateString('zh-CN');
        const icon = typeIcon[d.dreamType ?? 'neutral'] ?? '💭 梦境';
        const typeColor = d.dreamType === 'nightmare' ? red(icon)
          : d.dreamType === 'sweet' ? magenta(icon)
          : d.dreamType === 'weird' ? cyan(icon)
          : dim(icon);
        return `\n  ${typeColor}  ${dim(date)}\n${d.content.split('\n').map((l: string) => '  ' + l).join('\n')}`;
      }),
      divider(),
    ].join('\n');
  });

  // /give <item> <qty> | /give money <amount>
  add('give', async (args): Promise<string | CommandResult> => {
    if (!args.length) return '用法: /give <物品名> <数量> 或 /give money <金额>';
    if (args[0].toLowerCase() === 'money') {
      const amount = parseFloat(args[1] ?? '0');
      if (isNaN(amount) || amount <= 0) return '请输入有效金额';
      const ok = relSys.userToAi(amount);
      if (!ok) {
        const state = relSys.getState();
        return `余额不足！你的余额: ${Math.round(state.userCurrency)} 元`;
      }
      relSys.adjustAffection(2);
      memorySys.save('short', `他转账了 ${amount} 元给我`, 5);
      return {
        notice: `✅ 转账 ${amount} 元成功！好感度 +2`,
        triggerEvent: `[系统通知] 对方向你转账了 ${amount} 元。请自然地回应这份心意。`
      };
    } else {
      const itemName = args[0];
      const qty = parseInt(args[1] ?? '1', 10);
      if (isNaN(qty) || qty <= 0) return '请输入有效数量';
      const userItems = db.getInventory('user');
      const owned = userItems.find(i => i.itemName === itemName);
      if (!owned || owned.quantity < qty) {
        const has = owned?.quantity ?? 0;
        return `❌ 你的背包里只有 ${has} 个「${itemName}」，无法赠送 ${qty} 个`;
      }
      db.updateInventory('user', itemName, -qty);
      db.updateInventory('ai', itemName, qty);
      relSys.adjustAffection(1);
      memorySys.save('short', `他赠送了 ${qty} 个 ${itemName} 给我`, 5);
      return {
        notice: `✅ 赠送了 ${qty} 个「${itemName}」给Ta！好感度 +1`,
        triggerEvent: `[系统通知] 对方刚刚赠送了 ${qty} 个「${itemName}」给你。请自然地回应这份心意。`
      };
    }
  });

  // /tasks
  add('tasks', async () => {
    const raw = scheduler.formatForDisplay();
    if (!raw || raw.trim() === '（暂无任务）' || raw.trim() === '') return dim('（暂无任务）');
    return `${titleBar('任务列表', '📋')}\n${raw}\n${divider()}`;
  });

  // /news
  add('news', async () => {
    const news = sys.newsSys.getRecentNews(20);
    if (!news.length) return dim('（暂无新闻记录，等下次心跳自动获取）');
    const lines = news.map((n, idx) => {
      const shared = n.sharedAt ? green('✓') : dim('·');
      const src = n.source ? cyan(`[${n.source}]`) : '';
      let line = `  ${dim(String(idx).padStart(2, ' '))}. ${shared} ${src} ${bold(n.title)}`;
      if (n.summary) line += `\n     ${dim(n.summary.slice(0, 90))}${n.summary.length > 90 ? dim('…') : ''}`;
      if (n.url) line += `\n     ${dim('🔗')} ${dim(n.url)}`;
      return line;
    });
    return [
      titleBar('最近新闻', '📰'),
      ...lines,
      `  ${dim('/news_detail <序号>  查看新闻详情')}`,
      divider(),
    ].join('\n');
  });

  // /news_detail — 查看新闻详细内容
  add('news_detail', async (args) => {
    if (!args.length) return `用法: ${green('/news_detail <序号>')}`;
    const idx = parseInt(args[0], 10);
    if (isNaN(idx)) return '序号必须是数字';

    const detail = await sys.newsSys.getNewsDetail(idx);
    if (!detail) return red('❌ 新闻序号不存在');

    const lines: string[] = [
      titleBar('新闻详情', '📄'),
      `  ${bold(detail.title)}`,
      `  ${dim('来源:')} ${cyan(detail.source)}`,
    ];
    if (detail.url) lines.push(`  ${dim('链接:')} ${dim(detail.url)}`);

    if (detail.summary) {
      lines.push(`\n  ${header('📄 RSS摘要')}\n  ${detail.summary}`);
    } else if (detail.content) {
      lines.push(`\n  ${header('📄 内容')}\n  ${detail.content}`);
    } else if (detail.fetchError) {
      lines.push(`\n  ${yellow(`⚠️  无法获取详情: ${detail.fetchError}`)}`);
    } else {
      lines.push(`\n  ${dim('（该新闻暂无摘要，可通过链接查看原文）')}`);
    }
    lines.push(divider());
    return lines.join('\n');
  });

  // /inventory — 查看Ta的背包
  add('inventory', async () => {
    const items = db.getInventory('ai');
    if (!items.length) return dim(`（Ta的背包是空的）`);
    return [
      titleBar('Ta 的背包', '🎒'),
      ...items.map(i => `  ${dim('·')} ${i.itemName}  ${yellow('x' + i.quantity)}`),
      divider(),
    ].join('\n');
  });

  // /my_inventory — 查看自己的背包
  add('my_inventory', async () => {
    const items = db.getInventory('user');
    const rel = relSys.getState();
    const balanceLine = `  ${dim('💰 余额:')} ${yellow(Math.round(rel.userCurrency) + ' 元')}`;
    if (!items.length) return [
      titleBar('我的背包', '👜'),
      dim('  （背包空空如也）'),
      balanceLine,
      divider(),
    ].join('\n');
    return [
      titleBar('我的背包', '👜'),
      ...items.map(i => `  ${dim('·')} ${i.itemName}  ${yellow('x' + i.quantity)}`),
      balanceLine,
      divider(),
    ].join('\n');
  });

  // /shop — 查看商品列表
  add('shop', async (args) => {
    const rel = relSys.getState();
    const balanceLine = `  ${dim('💰 余额:')} ${yellow(Math.round(rel.userCurrency) + ' 元')}`;

    if (args[0]) {
      const matches = shopSys.findItems(args.join(' '));
      if (!matches.length) return dim(`未找到与「${args.join(' ')}」相关的商品`);
      return [
        titleBar(`商店搜索: "${args.join(' ')}"`, '🔍'),
        ...matches.map((item, i) =>
          `  ${dim(String(i + 1) + '.')} ${bold(item.name)}  ${yellow(String(item.price) + ' 元')}  ${dim(item.description)}`
        ),
        balanceLine,
        divider(),
      ].join('\n');
    }

    const allItems = shopSys.findItems('');
    if (!allItems.length) return dim('商店暂无商品');
    return [
      titleBar('商 店', '🛒'),
      ...allItems.map(item =>
        `  ${bold(item.name.padEnd(10))} ${yellow(String(item.price).padStart(5) + ' 元')}  ${dim(item.description)}`
      ),
      '',
      balanceLine,
      `  ${dim('购买:')} ${green('/buy <物品名> [数量]')}`,
      divider(),
    ].join('\n');
  });

  // 待选购买状态（模糊搜索命中多个时暂存）
  let pendingBuyItems: import('./systems/shop').ShopItem[] = [];
  let pendingBuyQty = 1;

  // /buy <物品名|序号> [数量]
  add('buy', async (args) => {
    if (!args.length) return '用法: /buy <物品名> [数量]  或搜索后输入序号选择';

    const lastArg = args[args.length - 1];
    const qty = parseInt(lastArg, 10);
    const hasQty = !isNaN(qty) && qty > 0 && args.length > 1;
    const queryOrIdx = hasQty ? args.slice(0, -1).join(' ') : args.join(' ');
    const buyQty = hasQty ? qty : 1;

    // 如果输入的是序号（且有待选列表）
    const idx = parseInt(queryOrIdx, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= pendingBuyItems.length) {
      const item = pendingBuyItems[idx - 1]!;
      pendingBuyItems = [];
      const result = shopSys.userBuy(item.name, buyQty);
      return result.message;
    }

    // 精确匹配
    const exactItem = shopSys.findItem(queryOrIdx);
    if (exactItem) {
      pendingBuyItems = [];
      return shopSys.userBuy(exactItem.name, buyQty).message;
    }

    // 模糊搜索
    const matches = shopSys.findItems(queryOrIdx);
    if (!matches.length) return `商店里没有「${queryOrIdx}」，试试 /shop <关键词> 搜索`;
    if (matches.length === 1) {
      pendingBuyItems = [];
      return shopSys.userBuy(matches[0]!.name, buyQty).message;
    }

    // 多个匹配 → 让用户选
    pendingBuyItems = matches.slice(0, 8);
    pendingBuyQty = buyQty;
    const lines = pendingBuyItems.map((item, i) =>
      `  ${dim(String(i + 1) + '.')} ${bold(item.name)}  ${yellow(String(item.price) + ' 元')}`
    );
    return `${cyan('?')} 找到 ${pendingBuyItems.length} 个匹配，请输入序号 ${dim('(如 /buy 1)')}\n${lines.join('\n')}`;
  });

  // /use <物品名> — 使用自己背包中的物品
  add('use', async (args) => {
    const itemName = args.join(' ');
    if (!itemName) return '用法: /use <物品名>';
    const result = shopSys.userUseItem(itemName);
    return result.message;
  });

  // /useitem <物品名> — 让Ta使用背包中的物品
  add('useitem', async (args) => {
    const itemName = args.join(' ');
    if (!itemName) return '用法: /useitem <物品名>';
    const result = shopSys.aiUseItem(itemName);
    if (!result.success) return result.message;
    return `✅ Ta使用了「${itemName}」。${result.message}`;
  });

  // /heartbeat
  add('heartbeat', async () => {
    logger.info('[Command] 手动触发心跳');
    await heartbeat.tick();
    return '心跳已触发';
  });

  // /wake [消息]  — 强制唤醒Ta，可附带聊天内容（在 handleUserMessage 特殊处理，此处仅备用）
  // 注意：实际处理逻辑在 handleUserMessage 的 /wake 特殊分支里，不走命令注册表

  // /context [prompt|history] — 查看当前 Prompt 和上下文用量
  add('context', async (args) => {
    const sub = (args[0] ?? '').toLowerCase();

    if (sub === 'prompt') {
      const prompt = promptBuilder.buildChatPrompt('（/context prompt）');
      const ctxMsg = promptBuilder.buildContextMessage('（/context prompt）');
      const parts = [
        `${titleBar(`System Prompt  (~${countTextTokens(prompt)} tokens)`, '🧠')}\n${dim(prompt)}\n${divider()}`,
        `${titleBar(`Assistant Context Message  (~${countTextTokens(ctxMsg)} tokens)`, '🗃️')}\n${dim(ctxMsg)}\n${divider()}`,
      ];
      return parts.join('\n');
    }

    if (sub === 'history') {
      const history = await contextMgr.getHistory();
      const summary = contextMgr.getLatestSummary();
      if (!history.length && !summary) return dim('（暂无历史记录）');

      const parts: string[] = [
        titleBar(`上下文历史  (${history.length}条${summary ? '+摘要' : ''})`, '💬'),
      ];
      if (summary) {
        parts.push(`  ${header('📄 摘要（已合并入系统提示）')}\n  ${dim(summary)}`);
        parts.push(divider());
      }

      history.forEach((m, i) => {
        // 旧格式：系统消息时间注入（兼容历史数据）
        if (m.role === 'system' && m.content && m.content.startsWith('当前时间：')) {
          const timeStr = m.content.replace('当前时间：', '').trim();
          parts.push(dim(`\n  ─────────────── ${timeStr} ───────────────`));
          return;
        }
        let label: string;
        if (m.role === 'system') {
          label = yellow('📄 [摘要]');
        } else if (m.role === 'user') {
          label = green('👤 你');
        } else if (m.role === 'tool') {
          // 工具结果消息
          const toolContent = m.content.slice(0, 100) + (m.content.length > 100 ? '...' : '');
          parts.push(`  ${dim(`[${i + 1}]`)} ${dim('[工具结果]')}\n  ${dim(toolContent)}`);
          parts.push(dim('  · · ·'));
          return;
        } else {
          label = magenta('💬 Ta');
          // assistant(tool_calls) 消息：显示工具调用摘要
          if ((m as any).tool_calls) {
            const names = (m as any).tool_calls.map((tc: any) => tc.function.name).join(', ');
            parts.push(`  ${dim(`[${i + 1}]`)} ${bold(label)} ${dim('[调用工具]')}\n  ${dim(names)}`);
            parts.push(dim('  · · ·'));
            return;
          }
        }
        // 检测时间前缀注入（格式: [2026-04-17 14:30]\n内容）
        const displayContent = m.content ?? '';
        const timePrefix = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n([\s\S]*)$/.exec(displayContent);
        if (timePrefix) {
          parts.push(dim(`\n  ─────────────── ${timePrefix[1]} ───────────────`));
          parts.push(`  ${dim(`[${i + 1}]`)} ${bold(label)}\n  ${timePrefix[2]}`);
        } else {
          parts.push(`  ${dim(`[${i + 1}]`)} ${bold(label)}\n  ${displayContent}`);
        }
        parts.push(dim('  · · ·'));
      });
      parts.push(divider());
      return parts.join('\n');
    }

    if (sub === 'clear') {
      contextMgr.clearHistory();
      return '✅ 对话历史已清空（记忆和状态未受影响）';
    }

    if (sub === 'clear-tools') {
      const count = contextMgr.clearToolHistory();
      return count > 0
        ? `✅ 已删除 ${count} 条工具调用上下文（普通对话历史保留）`
        : '（没有找到工具调用上下文记录）';
    }

    // 默认：统计信息
    const prompt = promptBuilder.buildChatPrompt('（/context）');
    const history = await contextMgr.getHistory();
    const summary = contextMgr.getLatestSummary();
    const promptTokens = countTextTokens(prompt);
    const summaryTokens = summary ? countTextTokens(summary) : 0;
    const historyTokens = countMessagesTokens(history);
    const totalTokens = promptTokens + summaryTokens + historyTokens;
    const perm = memorySys.getPermanentMemories().length;
    const long = db.getMemories('long').length;
    const short = db.getMemories('short').length;

    const bar = (tokens: number, max = totalTokens) => {
      const pct = Math.round((tokens / Math.max(max, 1)) * 20);
      return cyan('█'.repeat(pct)) + dim('░'.repeat(20 - pct));
    };

    return [
      titleBar('Context 用量', '📊'),
      kv('  🧠 System Prompt', `${yellow(`~${promptTokens}`)} tokens  ${bar(promptTokens)}`),
      summary ? kv('    └ 含摘要', `${dim(`~${summaryTokens}`)} tokens`) : null,
      kv('  💬 对话历史', `${yellow(`~${historyTokens}`)} tokens  ${bar(historyTokens)}  ${dim(`(${history.length}条)`)}`),
      kv('  📊 合计输入', `${bold(green(`~${totalTokens}`))} tokens`),
      '',
      `  ${header('📦 记忆库')}`,
      kv('    🔒 永久', `${cyan(String(perm))} 条`),
      kv('    📚 长期', `${cyan(String(long))} 条`),
      kv('    💬 短期', `${cyan(String(short))} 条`),
      '',
      `  ${dim('子命令:')} ${green('/context prompt')}       ${dim('查看完整系统提示词')}`,
      `          ${green('/context history')}      ${dim('查看对话历史')}`,
      `          ${green('/context clear')}        ${dim('清空对话历史（记忆不受影响）')}`,
      `          ${green('/context clear-tools')}  ${dim('删除工具调用上下文（保留普通对话）')}`,
      divider(),
    ].filter(v => v !== null).join('\n');
  });

  // /clear — 清空终端屏幕
  add('clear', async () => {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    return '';
  });

  // /compress — 手动触发上下文压缩
  add('compress', async () => {
    return await contextMgr.forceCompress();
  });

  // /work [小时] | /work quit — 用户打工
  add('work', async (args) => {
    if (args[0]?.toLowerCase() === 'quit') {
      if (!userWorkSys.isWorking()) return '你没有在打工';
      const quit = userWorkSys.quitWork();
      if (quit.net > 0) {
        return `你跑路了 🏃 按劳动时间结算 ${quit.earnedBeforeFee} 元，扣除跑路费 ${quit.fee} 元，实得 ${quit.net} 元`;
      }
      return `你跑路了 🏃 劳动所得 ${quit.earnedBeforeFee} 元，扣除跑路费 ${quit.fee} 元，一分没落到`;
    }
    if (userWorkSys.isWorking()) {
      return `你已经在打工了 💼 ${userWorkSys.getWorkDescription()}`;
    }
    const hours = args[0] ? parseFloat(args[0]) : undefined;
    if (hours !== undefined && isNaN(hours)) return '请输入有效时长（小时）';
    const result = userWorkSys.startWork(hours);
    return `💼 你开始打工了！将在 ${result.endTime.toLocaleTimeString('zh-CN')} 下班（${result.durationHours.toFixed(1)}小时），预计赚取 ${result.expectedEarning} 元\n打工期间无法与Ta聊天。输入 /work quit 跑路（按实际时间结算后扣10元跑路费）`;
  });

  // /block — 用户屏蔽AI主动消息
  add('block', async () => {
    db.setBlacklistByUser(true);
    return `你屏蔽了Ta的主动消息 （Ta不会主动联系你了）\n输入 /unblock 解除屏蔽`;
  });

  // /unblock — 解除用户对AI的屏蔽
  add('unblock', async () => {
    const bl = db.getBlacklist();
    if (!bl.blacklistedByUser) {
      return '你没有屏蔽Ta的主动消息';
    }
    db.setBlacklistByUser(false);
    return `✅ 已解除屏蔽，Ta可以主动联系你了`;
  });

  // /apply_unblock — 申请解除AI的拉黑
  add('apply_unblock', async () => {
    const bl = db.getBlacklist();
    if (!bl.blacklistedByAi) {
      return '你没有被Ta拉黑，无需申请';
    }
    // 注入上下文给AI，等待下一次心跳处理
    contextMgr.addUserMessage('【用户请求】请解除对我的拉黑，我会好好表现的。');
    return `已向Ta提交解除拉黑的请求，等待下一次心跳给你答复...`;
  });

  // /stats
  add('stats', async () => {
    const stats = db.getStats();
    const rel = relSys.getState();

    let friendDays = '—';
    if (stats.firstMessageAt) {
      const days = Math.floor((Date.now() - stats.firstMessageAt) / 86400000);
      friendDays = `${days} 天`;
    }

    const stages = [
      [0, '陌生人'], [20, '点头之交'], [40, '普通朋友'],
      [60, '好朋友'], [80, '亲密朋友'], [100, '挚友']
    ];
    const stage = stages.reduce((prev, cur) => rel.affection >= (cur[0] as number) ? cur : prev, stages[0]);

    return [
      titleBar('关系统计', '💕'),
      kv('  ⏱️  结识', friendDays),
      kv('  💬 消息数', `${yellow(String(stats.totalMessages))} 条  ${dim(`(你: ${stats.userMessages}  Ta: ${stats.aiMessages})`)}`),
      kv('  ❤️  好感度', `${valueColor(Math.round(rel.affection), String(Math.round(rel.affection)))}  ${dim(stage[1] as string)}`),
      kv('  💰 元', `你 ${yellow(rel.userCurrency.toFixed(0))}  Ta ${cyan(rel.aiCurrency.toFixed(0))}`),
      kv('  📔 日记', `${yellow(String(stats.diaryCount))} 篇`),
      kv('  💭 梦境', `${yellow(String(stats.dreamCount))} 次`),
      divider(),
    ].join('\n');
  });

  // /birthday set MM-DD | /birthday — 已移除

  // /remind <内容> <HH:mm | YYYY-MM-DD HH:mm>
  add('remind', async (args) => {
    if (args.length < 2) {
      return '用法: /remind <提醒内容> <时间>\n时间格式: HH:mm（今天）或 YYYY-MM-DD HH:mm';
    }
    // 最后一个或两个参数是时间，其余是内容
    const lastArg = args[args.length - 1];
    const secondLast = args[args.length - 2];

    let triggerTime: number | null = null;
    let contentArgs: string[];

    // 尝试 YYYY-MM-DD H:mm 或 HH:mm 格式（最后两个参数）
    const timeRegex = /^\d{1,2}:\d{2}$/;
    if (args.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(secondLast) && timeRegex.test(lastArg)) {
      const [hh, mm] = lastArg.split(':').map(Number);
      const padded = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      triggerTime = new Date(`${secondLast}T${padded}:00`).getTime();
      contentArgs = args.slice(0, -2);
    } else if (timeRegex.test(lastArg)) {
      // H:mm 或 HH:mm 格式（今天）
      const [hh, mm] = lastArg.split(':').map(Number);
      const d = new Date();
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // 已过则明天
      triggerTime = d.getTime();
      contentArgs = args.slice(0, -1);
    } else {
      return '❌ 时间格式错误。请使用 H:mm（今天）或 YYYY-MM-DD H:mm';
    }

    if (!triggerTime || isNaN(triggerTime)) return '❌ 时间解析失败，请检查格式';

    const content = contentArgs.join(' ');
    if (!content) return '❌ 提醒内容不能为空';

    const triggerDate = new Date(triggerTime);
    const timeStr = `${triggerDate.getMonth() + 1}月${triggerDate.getDate()}日 ${String(triggerDate.getHours()).padStart(2,'0')}:${String(triggerDate.getMinutes()).padStart(2,'0')}`;

    scheduler.create(`提醒: ${content}`, new Date(triggerTime), content, 'user');
    return `✅ 已设置提醒：「${content}」将在 ${timeStr} 提醒你`;
  });

  // /weather
  add('weather', async () => {
    const w = await weatherSys.fetchWeather();
    if (!w) return red('❌ 天气获取失败，请检查网络或配置（config/app.yaml → weather.city）');
    return [
      titleBar('天气', '🌤️'),
      kv('  📍 城市', w.city),
      kv('  🌤️  天气', w.description),
      kv('  🌡️  温度', `${yellow(String(w.temp))}°C  ${dim(`体感 ${w.feelsLike}°C`)}`),
      kv('  💧 湿度', `${w.humidity}%`),
      kv('  💨 风速', `${w.windSpeed} km/h`),
      divider(),
    ].join('\n');
  });

  // /usage
  add('usage', async () => {
    const total = db.getApiUsageSummary();
    if (total.requestCount === 0) return dim('暂无 token 使用记录');

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = db.getApiUsageSummary(todayStart.getTime());
    const byModel = db.getApiUsageByModel();

    return [
      titleBar('Token 使用统计', '📈'),
      kv('  📊 总请求', `${yellow(String(total.requestCount))} 次`),
      kv('  📥 总输入', `${yellow(String(total.promptTokens))} tokens`),
      kv('  📤 总输出', `${yellow(String(total.completionTokens))} tokens`),
      kv('  🔢 总计', `${bold(green(String(total.totalTokens)))} tokens`),
      '',
      `  ${header('今日')}`,
      kv('    输入', `${yellow(String(today.promptTokens))} tokens`),
      kv('    输出', `${yellow(String(today.completionTokens))} tokens`),
      kv('    合计', `${green(String(today.totalTokens))} tokens  ${dim(`(${today.requestCount}次)`)}`),
      '',
      `  ${header('按模型')}`,
      ...byModel.map(item =>
        `  ${dim('·')} ${cyan(item.model)} ${dim('[' + item.endpoint + ']')}\n    ${dim('输入')} ${yellow(String(item.promptTokens))} / ${dim('输出')} ${yellow(String(item.completionTokens))} / ${dim('合计')} ${green(String(item.totalTokens))} ${dim(`(${item.requestCount}次)`)}`
      ),
      divider(),
    ].join('\n');
  });

  // /debug — 调试命令组（需在 app.yaml 中设置 debug: true 开启）
  add('debug', async (args) => {
    if (!debugMode) return '⚠️ 调试模式未开启，请在 app.yaml 中设置 debug: true';
    const sub = (args[0] ?? '').toLowerCase();

    switch (sub) {
      case 'unblock': {
        db.setBlacklistByAi(false);
        db.setBlacklistByUser(false);
        return '✅ [DEBUG] 已强制解除所有拉黑/屏蔽状态';
      }
      case 'sleep': {
        const hours = parseFloat(args[1] ?? '1');
        const h = isNaN(hours) ? 1 : hours;
        sleepSys.startSleep(h);
        return `✅ [DEBUG] 已强制她进入睡眠，持续 ${h} 小时`;
      }
      case 'wake': {
        sleepSys.forceWakeUp();
        return '✅ [DEBUG] 已强制唤醒';
      }
      case 'emotion': {
        // /debug emotion joy=80 sadness=10
        const changes: Record<string, number> = {};
        for (const part of args.slice(1)) {
          const [k, v] = part.split('=');
          if (k && v) changes[k] = parseFloat(v);
        }
        if (Object.keys(changes).length === 0) {
          return `当前情绪:\n${emotionSys.toFullString()}`;
        }
        emotionSys.update(changes);
        return `✅ [DEBUG] 情绪已调整:\n${emotionSys.toFullString()}`;
      }
      case 'health': {
        // /debug health health=80 fatigue=20
        const h = parseFloat(args.find(a => a.startsWith('health='))?.split('=')[1] ?? 'NaN');
        const f = parseFloat(args.find(a => a.startsWith('fatigue='))?.split('=')[1] ?? 'NaN');
        if (!isNaN(h) || !isNaN(f)) {
          healthSys.adjust({ health: isNaN(h) ? 0 : h - healthSys.getHealth(), fatigue: isNaN(f) ? 0 : f - healthSys.getFatigue() });
          return `✅ [DEBUG] 健康值已调整:\n${healthSys.toPromptString()}`;
        }
        return `当前健康状态:\n${healthSys.toPromptString()}`;
      }
      case 'favor': {
        const val = parseFloat(args[1] ?? 'NaN');
        if (!isNaN(val)) {
          relSys.setFavorDirect(val);
          return `✅ [DEBUG] 好感度已设置为 ${val}`;
        }
        return `当前好感度: ${relSys.getState().affection}`;
      }
      case 'work_stop': {
        if (!workSys.isWorking()) return '[DEBUG] Ta 当前没有在打工';
        workSys.forceStop();
        return '✅ [DEBUG] 已强制让 Ta 下班（无回来流程）';
      }
      case 'work_finish': {
        if (!workSys.isWorking()) return '[DEBUG] Ta 当前没有在打工';
        heartbeat.forceWorkEnd();
        return '✅ [DEBUG] 已强制完成打工，正在触发回来流程...';
      }
      case 'sleep_dream': {
        const hours = parseFloat(args[1] ?? '1');
        const h = isNaN(hours) ? 1 : hours;
        sleepSys.startSleep(h);
        await new Promise(r => setTimeout(r, 300));
        heartbeat.forceDream();
        return `✅ [DEBUG] 已强制她进入睡眠（${h}h），并立即触发梦境生成`;
      }
      case 'wake_natural': {
        if (!sleepSys.isAsleep()) return '[DEBUG] Ta 当前没有在睡觉';
        heartbeat.forceWakeAndProcess();
        return '✅ [DEBUG] 已强制她自然醒，正在触发起床流程...';
      }
      case 'tick': {
        heartbeat.forceTick();
        return '✅ [DEBUG] 已触发一次心跳';
      }
      case 'reset_chat':
      case 'reset-chat': {
        contextMgr.clearHistory();
        db.clearMemories(['short', 'long']);
        return '✅ [DEBUG] 已重置聊天数据（已清空对话历史、短期记忆、长期记忆；保留永久记忆）';
      }
      case 'news': {
        try {
          const fetched = await newsSys.fetchNews(true);  // 强制刷新
          const all = newsSys.getRecentNews(20);
          if (!all.length) return '[DEBUG] 获取到 0 条新闻（源可能无新内容）';
          const header = `===== 最新新闻（已强制刷新，本次新增 ${fetched.length} 条）=====`;
          return header + '\n' + all.map((n: any, i: number) => {
            const shared = n.sharedAt ? '✓' : '·';
            const sumPreview = n.summary ? ` — ${n.summary.slice(0, 60)}...` : '';
            return `${shared} ${i}. ${n.title} (${n.source})${sumPreview}`;
          }).join('\n');
        } catch (e) {
          return `[DEBUG] 获取新闻失败: ${e}`;
        }
      }
      case 'weather': {
        const w = weatherSys.getWeather();
        if (!w) return '[DEBUG] 暂无天气缓存，正在获取...\n' + await weatherSys.fetchWeather().then(r => r ? `${r.city} ${r.description} ${r.temp}°C` : '获取失败');
        return `[DEBUG] 天气: ${w.city} ${w.description} ${w.temp}°C（体感${w.feelsLike}°C）湿度${w.humidity}% 风速${w.windSpeed}km/h`;
      }
      case 'currency': {
        // /debug currency [user|ai] <金额>  — 为用户/AI增加元（上限500）
        const target = (args[1] ?? 'user') as 'user' | 'ai';
        const rawAmt = parseFloat(args[2] ?? args[1] ?? 'NaN');
        if (isNaN(rawAmt)) {
          const st = relSys.getState();
          return `[DEBUG] 当前余额 — 用户: ${st.userCurrency}，Ta: ${st.aiCurrency}`;
        }
        if (!['user', 'ai'].includes(target)) return '[DEBUG] 用法: /debug currency [user|ai] <金额>';
        const capped = Math.min(500, Math.max(0, Math.round(rawAmt)));
        relSys.adjustCurrency(target, capped);
        const newBal = relSys.getState();
        return `✅ [DEBUG] 已为${target === 'user' ? '用户' : 'Ta'}增加 ${capped} 元（单次上限500）\n用户余额: ${newBal.userCurrency}，Ta余额: ${newBal.aiCurrency}`;
      }
      case 'naked': {
        // 忽略所有上下文/记忆，仅带行动标签文档直接调用模型
        const nakedMsg = args.join(' ').trim();
        if (!nakedMsg) return '[DEBUG] 用法: /debug naked <消息内容>';
        const tagDoc = promptBuilder.getTagInstructionsPublic('chat');
        const nakedSysPrompt = `你是一个AI助手，理解以下行动标签并在回复中使用它们。\n${tagDoc}`;
        const nakedMessages = [
          { role: 'system' as const, content: nakedSysPrompt },
          { role: 'user' as const, content: nakedMsg },
        ];
        try {
          const rawResp = await ai.chat(nakedMessages);
          return `[DEBUG naked 原始输出]\n${rawResp}`;
        } catch (e) {
          return `[DEBUG naked] 调用失败: ${e}`;
        }
      }
      case 'del_msg': {
        // 删除指定上下文消息
        // 支持两种写法：/debug del_msg <序号>  或  /debug del_msg id:<DB_ID>
        const idxStr = args[1];
        if (!idxStr) {
          // 显示带 DB ID 的历史供用户选择
          const rows = contextMgr.getHistoryWithIds();
          if (!rows.length) return '[DEBUG] 当前无对话历史';
          const lines = rows.map((m, i) => {
            const label = m.role === 'user' ? '你' : 'Ta';
            const preview = (m.contentVisible || m.content).replace(/\n/g, ' ').slice(0, 60);
            return `  [${i + 1}] (DB#${m.id}) ${label}: ${preview}`;
          });
          return `[DEBUG] 用法:\n  /debug del_msg <序号>     — 按列表序号删除（如 /debug del_msg 15）\n  /debug del_msg id:<DB_ID> — 按 DB ID 删除（如 /debug del_msg id:40）\n当前历史:\n${lines.join('\n')}`;
        }
        // 支持 id:N 语法（直接用 DB ID）
        if (idxStr.toLowerCase().startsWith('id:')) {
          const dbId = parseInt(idxStr.slice(3), 10);
          if (isNaN(dbId)) return '[DEBUG] 无效 DB ID';
          const ok = contextMgr.deleteMessageById(dbId);
          return ok ? `✅ [DEBUG] DB#${dbId} 已删除` : `[DEBUG] DB ID ${dbId} 不存在`;
        }
        const idx = parseInt(idxStr, 10);
        if (isNaN(idx) || idx < 1) return '[DEBUG] 无效序号（纯数字视为序号，DB ID 请用 id:40 格式）';
        const ok = contextMgr.deleteMessageByIndex(idx);
        return ok ? `✅ [DEBUG] 第 ${idx} 条消息已删除` : `[DEBUG] 序号 ${idx} 不存在`;
      }
      default:
        return [
          '===== 调试命令 (debug: true 模式) =====',
          '/debug unblock              — 强制解除所有拉黑/屏蔽',
          '/debug sleep [小时]          — 强制进入睡眠',
          '/debug sleep_dream [小时]    — 强制进入睡眠并立即触发梦境',
          '/debug wake                 — 强制唤醒（不触发起床流程）',
          '/debug wake_natural         — 强制自然醒（触发完整起床流程）',
          '/debug emotion [key=val]    — 查看/设置情绪值',
          '/debug health [health=N fatigue=N] — 查看/设置健康值',
          '/debug favor [数值]          — 查看/设置好感度',
          '/debug currency [user|ai] <金额>  — 增加元（单次上限500）',
          '/debug work_stop             — 强制让 Ta 下班（无回来流程）',
          '/debug work_finish           — 强制完成打工（触发完整回来流程）',
          '/debug tick                 — 手动触发一次心跳',
          '/debug reset_chat           — 重置聊天数据（保留永久记忆）',
          '/debug news                 — 实时获取新闻',
          '/debug weather              — 查看天气缓存',
          '/debug naked <消息>          — 忽略上下文仅带标签文档调用模型（测试原始输出）',
          '/debug del_msg [序号]        — 删除指定上下文消息（不带序号时列出所有消息）',
        ].join('\n');
    }
  });

  // /help
  add('help', async () => {
    const cmd = (c: string, desc: string) => `  ${green(c.padEnd(40))} ${dim(desc)}`;
    const sec = (title: string) => `\n  ${header(title)}`;
    const debugLine = debugMode ? cmd('/debug', '调试命令（debug模式）') : '';
    return [
      titleBar('可用命令', '📖'),
      sec('状态'),
      cmd('/status', '查看Ta的当前状态'),
      cmd('/stats', '查看关系统计数据'),
      cmd('/weather', '查看当前天气'),
      cmd('/usage', '查看模型 token 总使用量'),
      sec('日记 / 梦境'),
      cmd('/view_diary [日期|页码|u|d]', '查看日记（日期YYYY-MM-DD，数字/u/d翻页，s 搜索）'),
      cmd('/dreams', '查看梦境记录'),
      sec('记忆 / 上下文'),
      cmd('/memories [all|<页码>|search <词>]', '查看记忆（all=全部，数字=翻页，search=搜索）'),
      cmd('/context [prompt|history|clear|clear-tools]', 'Token用量/系统提示词/历史/清空/清工具记录'),
      cmd('/compress', '手动触发上下文压缩'),
      sec('新闻'),
      cmd('/news', '查看最近新闻列表'),
      cmd('/news_detail <序号>', '查看新闻详细内容'),
      sec('关系 / 互动'),
      cmd('/give <物品> <数量>', '赠送物品给Ta'),
      cmd('/give money <金额>', '给Ta转账元'),
      sec('任务 / 提醒'),
      cmd('/tasks', '查看任务列表'),
      cmd('/remind <内容> <时间>', '设置提醒（时间: HH:mm 或 YYYY-MM-DD HH:mm）'),
      sec('背包 / 商店'),
      cmd('/inventory', '查看Ta的背包'),
      cmd('/my_inventory', '查看自己的背包'),
      cmd('/shop [关键词]', '查看/搜索商店'),
      cmd('/buy <物品|序号> [数量]', '购买物品（支持模糊搜索）'),
      cmd('/use <物品>', '使用自己的物品'),
      cmd('/useitem <物品>', '让Ta使用物品'),
      sec('系统'),
      cmd('/wake [消息]', '强制唤醒Ta（可附带消息）'),
      cmd('/work [小时]', '去打工赚钱（打工期间无法与Ta聊天）'),
      cmd('/work quit', '跑路（没有工资）'),
      cmd('/channel [信道名]', '查看或切换活跃信道（AI回复目标）'),
      cmd('/preferred-channel [信道名]', '设置优先信道（优先发送到该信道，即使未激活）'),
      cmd('/block', '屏蔽Ta的主动消息'),
      cmd('/unblock', '解除屏蔽'),
      cmd('/apply_unblock', '申请解除拉黑'),
      cmd('/clear', '清空终端屏幕'),
      cmd('/api <消息>', '直接调用AI接口（不带上下文，用于测试）'),
      sec('记忆查看'),
      cmd('/memories', '第1页（10条/页）'),
      cmd('/memories all', '查看全部记忆（分长/短期）'),
      cmd('/memories <页码>', '翻页'),
      cmd('/memories search <关键词>', '搜索记忆'),
      sec('启动参数（命令行）'),
      `  ${green('--active-channel <名称>'.padEnd(40))} ${dim('强制设置初始激活信道')}`,
      `  ${green('--onboard'.padEnd(40))} ${dim('进入首次配置向导')}`,
      debugLine,
      divider(),
    ].filter(v => v !== '').join('\n');
  });
}

/**
 * 额外的命令注册：需要信道/AI 实时变量的命令
 */
export function registerExtraCommands(
  add: (name: string, handler: (args: string[]) => Promise<string | CommandResult | void>) => void,
  sys: Systems & { ai: AIClient },
  channels: IChannel[],
  getLastActiveChannel: () => IChannel | undefined,
  setLastActiveChannel: (ch: IChannel) => void,
  getPreferredChannelName: () => string | null,
  setPreferredChannelName: (name: string | null) => void
): void {
  const { ai } = sys;

  // /api <消息> — 直接调用 AI（不带上下文/记忆，用于测试）
  add('api', async (args) => {
    if (!args.length) return '用法: /api <发送给AI的消息>';
    const msg = args.join(' ');
    try {
      const resp = await ai.chat([{ role: 'user', content: msg }], 0.7);
      return `[API 直接响应]\n${resp}`;
    } catch (e) {
      return `[API 错误] ${e}`;
    }
  });

  // /channel [name] — 查看或切换当前活跃信道（AI 回复目标）
  add('channel', async (args) => {
    if (!args.length) {
      const activeName = getLastActiveChannel()?.name ?? '(未设置)';
      const channelNames = channels.map(ch => ch.name).join(', ');
      return `当前活跃信道: ${activeName}\n可用信道: ${channelNames}\n用法: /channel <信道名>`;
    }
    const target = args[0]!.toLowerCase();
    const found = channels.find(ch => ch.name.toLowerCase() === target);
    if (!found) {
      const channelNames = channels.map(ch => ch.name).join(', ');
      return `未找到信道 "${target}"，可用信道: ${channelNames}`;
    }
    setLastActiveChannel(found);
    return `已切换活跃信道为: ${found.name}（后续 AI 消息将发送到此信道）`;
  });

  // /preferred-channel [name] — 设置优先信道（即使未激活，也优先发送到该信道；留空则清除）
  add('preferred-channel', async (args) => {
    if (!args.length) {
      const current = getPreferredChannelName();
      if (!current) {
        const channelNames = channels.map(ch => ch.name).join(', ');
        return `当前未设置优先信道\n可用信道: ${channelNames}\n用法: /preferred-channel <信道名>`;
      }
      return `当前优先信道: ${current}`;
    }
    const target = args[0]!.toLowerCase();
    if (target === 'clear' || target === 'none') {
      setPreferredChannelName(null);
      return '已清除优先信道设置';
    }
    const found = channels.find(ch => ch.name.toLowerCase() === target);
    if (!found) {
      const channelNames = channels.map(ch => ch.name).join(', ');
      return `未找到信道 "${target}"，可用信道: ${channelNames}`;
    }
    setPreferredChannelName(found.name);
    return `已设置优先信道为: ${found.name}（后续 AI 主动消息将优先发送到此信道，即使未激活也会发送）`;
  });
}