import axios from 'axios';
import { load } from 'cheerio';
import { Database, NewsItem } from '../database/db';
import { NewsConfig } from '../config/types';

interface ParsedNews {
  title: string;
  url?: string;
  source: string;
  summary?: string;
}

export class NewsSystem {
  private lastFetchTime = 0;

  constructor(private db: Database, private cfg: NewsConfig) {}

  /** 获取新闻（内部调用，带缓冲） */
  async fetchNews(force = false): Promise<ParsedNews[]> {
    const now = Date.now();
    if (!force && now - this.lastFetchTime < this.cfg.fetchIntervalHours * 60 * 60 * 1000) {
      return [];  // 未到抓取间隔
    }
    this.lastFetchTime = now;

    // 并行从所有源获取新闻（各源结果独立）
    const shuffledSources = [...this.cfg.sources].sort(() => Math.random() - 0.5);
    const perSourceResults = await Promise.allSettled(
      shuffledSources.map(src => this.fetchFromSource(src))
    );

    // 每个源的结果（失败的返回空数组），先在各源内随机打乱
    const sourceArrays = perSourceResults.map(r =>
      r.status === 'fulfilled' ? [...r.value].sort(() => Math.random() - 0.5) : []
    );

    // 轮询各源，确保新闻来自不同来源（round-robin）
    const interleaved: ParsedNews[] = [];
    const maxPerSource = Math.ceil(this.cfg.maxItems / Math.max(1, sourceArrays.filter(a => a.length > 0).length));
    const counters = new Array(sourceArrays.length).fill(0);
    let added = true;
    while (interleaved.length < this.cfg.maxItems && added) {
      added = false;
      for (let i = 0; i < sourceArrays.length && interleaved.length < this.cfg.maxItems; i++) {
        if (counters[i] < sourceArrays[i].length && counters[i] < maxPerSource) {
          interleaved.push(sourceArrays[i][counters[i]]);
          counters[i]++;
          added = true;
        }
      }
    }

    const saved: ParsedNews[] = [];
    for (const item of interleaved) {
      this.db.saveNews({ ...item, fetchedAt: Date.now(), sharedAt: null });
      saved.push(item);
    }

    return saved;
  }

  /** 获取未分享的新闻 */
  getUnsharedNews(limit = 3): NewsItem[] {
    return this.db.getUnsharedNews(limit);
  }

  /** 获取单条新闻的详细内容（用于交互式查看） */
  async getNewsDetail(index: number): Promise<{ title: string; source: string; url?: string; summary?: string; content?: string; fetchError?: string } | null> {
    const news = this.getRecentNews(20);
    if (index < 0 || index >= news.length) return null;
    
    const item = news[index];
    let content: string | undefined;
    let fetchError: string | undefined;
    
    // 如果数据库中已有 summary，优先使用
    if (!item.summary && item.url) {
      try {
        content = await this.fetchArticleContent(item.url);
        if (!content) {
          fetchError = '网页内容为空或被拒绝访问';
        }
      } catch (e: any) {
        fetchError = e?.message ?? '获取失败';
      }
    }
    
    return {
      title: item.title,
      source: item.source,
      url: item.url,
      summary: item.summary,
      content,
      fetchError
    };
  }

  getRecentNews(limit = 10): NewsItem[] {
    return this.db.getRecentNews(limit);
  }

  /** 标记新闻为已分享 */
  markShared(id: number): void {
    this.db.markNewsShared(id);
  }

  /** 从RSS源获取新闻 */
  private async fetchFromSource(url: string): Promise<ParsedNews[]> {
    const sourceName = this.getSourceName(url);
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        responseType: 'text'
      });

      const text = response.data as string;
      if (!text || typeof text !== 'string') {
        return [];
      }
      return await this.parseRSS(text, sourceName);
    } catch (err: any) {
      console.warn(`[News] 获取 ${sourceName} 失败: ${err?.message ?? err}`);
      return [];
    }
  }

  private async parseRSS(xml: string, source: string): Promise<ParsedNews[]> {
    const news: ParsedNews[] = [];

    // 检测是否为 Atom 格式
    const isAtom = /<feed[\s>]/i.test(xml);

    if (isAtom) {
      // 解析 Atom 格式 (<entry> 标签)
      const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
      let match;
      while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];
        const titleMatch = /<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/i.exec(entry);
        // Atom link: <link href="..." /> 或 <link rel="alternate" href="..." />
        const linkMatch = /<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i.exec(entry);
        const summaryMatch = /<summary[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/summary>|<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(entry);
        const contentMatch = /<content[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/content>|<content[^>]*>([\s\S]*?)<\/content>/i.exec(entry);

        if (titleMatch) {
          const title = (titleMatch[1] || titleMatch[2] || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
          const url = linkMatch?.[1]?.trim();
          const rawSummary = (summaryMatch?.[1] || summaryMatch?.[2] || contentMatch?.[1] || contentMatch?.[2] || '').trim();
          const summaryText = rawSummary.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          const summary = summaryText.length > 20 ? summaryText.slice(0, 300) : undefined;
          if (title && title.length > 2) {
            news.push({ title, url, source, summary });
          }
        }
        if (news.length >= 10) break;
      }
    } else {
      // 解析 RSS 格式 (<item> 标签)
      const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const item = match[1];
        const titleMatch = /<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/i.exec(item);
        const linkMatch = /<link[^>]*>(.*?)<\/link>/i.exec(item);
        const descMatch = /<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description[^>]*>([\s\S]*?)<\/description>/i.exec(item);

        if (titleMatch) {
          const title = (titleMatch[1] || titleMatch[2] || '').trim();
          const url = linkMatch?.[1]?.trim();
          const descRaw = (descMatch?.[1] || descMatch?.[2] || '').trim();
          const descText = descRaw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          const summary = descText.length > 20 ? descText.slice(0, 300) : undefined;
          if (title && title.length > 2) {
            news.push({ title, url, source, summary });
          }
        }
        if (news.length >= 10) break;
      }
    }

    return news;
  }

  /** 爬取文章内容 */
  private async fetchArticleContent(url: string): Promise<string | undefined> {
    try {
      const resp = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const html = resp.data as string;
      const $ = load(html);
      
      // 移除脚本和样式
      $('script, style, noscript, nav, footer, [role=navigation]').remove();
      
      // 尝试多种选择器提取内容
      let content = '';
      
      // 优先获取 article 标签
      const article = $('article').text();
      if (article && article.trim().length > 50) {
        content = article;
      } else {
        // 尝试其他选择器
        const selectors = [
          '[class*="content"]',
          '[class*="article"]',
          '[class*="body"]',
          '[class*="main"]',
          'main'
        ];
        
        for (const sel of selectors) {
          const text = $(sel).first().text();
          if (text && text.trim().length > 50) {
            content = text;
            break;
          }
        }
        
        // 如果还没有内容，连接所有 p 标签
        if (!content) {
          content = $('p').map((_, el) => $(el).text()).get().join(' ');
        }
      }
      
      if (content && content.length > 20) {
        // 清理空白，限制长度到 800 字
        content = content.replace(/\s+/g, ' ').trim().slice(0, 800);
        return content;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private getSourceName(url: string): string {
    if (url.includes('ycombinator') || url.includes('news.hn')) return 'Hacker News';
    if (url.includes('bloomberg')) return 'Bloomberg';
    if (url.includes('arstechnica')) return 'Ars Technica';
    if (url.includes('ruanyifeng')) return '阮一峰博客';
    if (url.includes('sspai')) return '少数派';
    if (url.includes('v2ex')) return 'V2EX';
    if (url.includes('coolshell')) return '酷壳';
    if (url.includes('geekpark')) return '极客公园';
    if (url.includes('infoq.cn')) return 'InfoQ';
    if (url.includes('36kr')) return '36氪';
    if (url.includes('juejin')) return '掘金';
    if (url.includes('ithome')) return 'IT之家';
    try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
  }

  /** 格式化新闻用于提示词（简洁版，控制token） */
  formatForPrompt(news: NewsItem[]): string {
    if (!news.length) return '';
    return news.map(n => {
      const base = `· [${n.source}] ${n.title}`;
      return n.summary ? `${base}——${n.summary.slice(0, 100)}` : base;
    }).join('\n');
  }
}
