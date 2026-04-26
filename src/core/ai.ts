import OpenAI from 'openai';
import { ApiConfig, ModelEndpointConfig, ModelPool, ModelPoolItem } from '../config/types';
import { logger } from '../utils/logger';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Native function calling types ──

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, string>;
}

export interface ChatWithToolsResult {
  content: string;
  toolCalls: ToolCallResult[];
}

/** 工具调用流程中的扩展消息格式（含 tool role 和 tool_calls） */
export type ToolChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

interface ResolvedEndpoint {
  client: OpenAI;
  label: 'main' | 'mini' | 'vision';
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraBody?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chatTemplateKwargs?: Record<string, any> | null;
}

interface InternalPool {
  strategy: 'random' | 'fallback';
  candidates: ResolvedEndpoint[];
  weights: number[];
  label: 'main' | 'mini' | 'vision';
}

type EndpointSource =
  | { kind: 'single'; ep: ResolvedEndpoint }
  | { kind: 'pool'; pool: InternalPool };

export interface TokenUsageRecord {
  endpoint: 'main' | 'mini' | 'vision';
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class AIClient {
  private mainSource: EndpointSource;
  private miniSource: EndpointSource;
  private visionSource: EndpointSource;
  charName: string = 'Ta';
  lastUsedModel: string = '';  // 最后使用的模型

  constructor(
    private cfg: ApiConfig,
    private onUsage?: (usage: TokenUsageRecord) => void,
    private logRequests = false
  ) {
    const pools = cfg.modelPools ?? {};
    this.mainSource = this.resolveSource('main', cfg.main, pools);
    this.miniSource = this.resolveSource('mini', cfg.mini ?? cfg.main, pools);
    this.visionSource = this.resolveSource('vision', cfg.vision ?? cfg.main, pools);
  }

  /** 解析端点或模型集 */
  private resolveSource(
    label: 'main' | 'mini' | 'vision',
    endpointCfg: ModelEndpointConfig,
    pools: Record<string, ModelPool>
  ): EndpointSource {
    const poolName = endpointCfg.pool;
    if (poolName) {
      const poolDef = pools[poolName];
      if (!poolDef) throw new Error(`模型集 "${poolName}" 未定义，请检查 api.modelPools`);
      if (!poolDef.models || poolDef.models.length === 0) {
        throw new Error(`模型集 "${poolName}" 没有候选模型`);
      }
      const candidates = poolDef.models.map(item => this.resolveFromPoolItem(label, item, endpointCfg));
      const weights = poolDef.models.map(m => (m.weight ?? 1));
      logger.debug(`[AI:Pool] 已加载模型集 "${poolName}" [${poolDef.strategy}] 共 ${candidates.length} 个模型: ${candidates.map(c => c.model).join(', ')}`);
      return { kind: 'pool', pool: { strategy: poolDef.strategy, candidates, weights, label } };
    }
    return { kind: 'single', ep: this.resolve(label, endpointCfg) };
  }

  /** 从 ModelPoolItem 解析 ResolvedEndpoint，回退字段来自父端点配置 */
  private resolveFromPoolItem(
    label: 'main' | 'mini' | 'vision',
    item: ModelPoolItem,
    parent: ModelEndpointConfig
  ): ResolvedEndpoint {
    const merged: ModelEndpointConfig = {
      model: item.model,
      baseUrl: item.baseUrl ?? parent.baseUrl,
      apiKey: item.apiKey ?? parent.apiKey,
      temperature: item.temperature ?? parent.temperature,
      maxTokens: item.maxTokens ?? parent.maxTokens,
      extraBody: (parent.extraBody || item.extraBody)
        ? { ...(parent.extraBody ?? {}), ...(item.extraBody ?? {}) }
        : undefined,
      // chatTemplateKwargs：item 优先（包括显式 null），item 无则用 parent
      ...(Object.prototype.hasOwnProperty.call(item, 'chatTemplateKwargs')
        ? { chatTemplateKwargs: item.chatTemplateKwargs }
        : Object.prototype.hasOwnProperty.call(parent, 'chatTemplateKwargs')
          ? { chatTemplateKwargs: parent.chatTemplateKwargs }
          : {}),
    };
    return this.resolve(label, merged);
  }

  /** 根据模型配置解析端点，回退到全局 baseUrl/apiKey */
  private resolve(label: 'main' | 'mini' | 'vision', modelCfg: ModelEndpointConfig): ResolvedEndpoint {
    const baseURL = modelCfg.baseUrl ?? this.cfg.baseUrl;
    const apiKey = modelCfg.apiKey ?? this.cfg.apiKey ?? 'no-key';
    const model = modelCfg.model ?? this.cfg.model;
    if (!model) {
      throw new Error(`AI 模型未配置：${label}`);
    }
    const globalExtra = this.cfg.extraBody;
    const localExtra = modelCfg.extraBody;
    const extraBody = (globalExtra || localExtra)
      ? { ...(globalExtra ?? {}), ...(localExtra ?? {}) }
      : undefined;

    const globalCtk = this.cfg.chatTemplateKwargs;
    // 优先级：模型级配置 > 全局配置。模型级未显式设置时才继承全局
    const chatTemplateKwargs = Object.prototype.hasOwnProperty.call(modelCfg, 'chatTemplateKwargs') 
      ? modelCfg.chatTemplateKwargs 
      : globalCtk;

    return {
      client: new OpenAI({ baseURL, apiKey }),
      label,
      baseUrl: baseURL,
      model,
      temperature: modelCfg.temperature,
      maxTokens: modelCfg.maxTokens,
      extraBody,
      chatTemplateKwargs,
    };
  }

  /** 从模型集中按权重随机选一个候选 */
  private pickRandom(pool: InternalPool): ResolvedEndpoint {
    const total = pool.weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < pool.candidates.length; i++) {
      r -= pool.weights[i];
      if (r <= 0) return pool.candidates[i];
    }
    return pool.candidates[pool.candidates.length - 1];
  }

  /** 按 fallback 策略依次尝试候选模型，成功即返回 */
  private async callWithFallback(
    pool: InternalPool,
    messages: ChatMessage[],
    temperature: number,
    maxTokens: number,
    abortSignal?: AbortSignal
  ): Promise<string> {
    let lastErr: unknown;
    for (const candidate of pool.candidates) {
      try {
        if (abortSignal?.aborted) throw new Error('Request aborted');
        return await this.callEndpoint(candidate, messages, temperature, maxTokens, abortSignal);
      } catch (e) {
        logger.warn(`[AI:Pool:fallback] ${candidate.model} 失败，尝试下一个: ${(e as Error)?.message ?? e}`);
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('[AI:Pool] 所有候选模型均失败');
  }

  /** 根据 EndpointSource 选择端点，返回 [ep, maxTokens, temperature] */
  private pickEndpoint(
    src: EndpointSource,
    defaultMaxTokens: number,
    overrideTemperature?: number
  ): { ep: ResolvedEndpoint; maxTokens: number; temp: number; isPool: boolean } {
    if (src.kind === 'pool') {
      const ep = this.pickRandom(src.pool);
      const maxTokens = ep.maxTokens ?? defaultMaxTokens;
      const temp = overrideTemperature ?? ep.temperature ?? this.cfg.temperature;
      return { ep, maxTokens, temp, isPool: true };
    }
    const ep = src.ep;
    const maxTokens = ep.maxTokens ?? defaultMaxTokens;
    const temp = overrideTemperature ?? ep.temperature ?? this.cfg.temperature;
    return { ep, maxTokens, temp, isPool: false };
  }

  /** 主模型对话 */
  async chat(messages: ChatMessage[], temperature?: number, abortSignal?: AbortSignal, maxTokensOverride?: number): Promise<string> {
    const src = this.mainSource;
    const defaultMax = maxTokensOverride ?? this.cfg.chatMaxTokens ?? 600;
    if (src.kind === 'pool' && src.pool.strategy === 'fallback') {
      const ep0 = src.pool.candidates[0];
      const maxTokens = ep0.maxTokens ?? defaultMax;
      const temp = temperature ?? ep0.temperature ?? this.cfg.temperature;
      return this.callWithFallback(src.pool, messages, temp, maxTokens, abortSignal);
    }
    const { ep, maxTokens, temp } = this.pickEndpoint(src, defaultMax, temperature);
    return this.callEndpoint(ep, messages, temp, maxTokens, abortSignal);
  }

  /** 主模型对话（流式，返回 AsyncGenerator 逐块 yield 内容） */
  async *chatStream(messages: ChatMessage[], temperature?: number): AsyncGenerator<string> {
    // 流式模式：random 策略随机选一个；fallback 策略依次尝试（错误在 create 时抛出）
    let ep: ResolvedEndpoint;
    const src = this.mainSource;
    const defaultMax = this.cfg.chatMaxTokens ?? 600;

    if (src.kind === 'pool') {
      if (src.pool.strategy === 'fallback') {
        // fallback 策略：尝试每个候选
        let lastErr: unknown;
        for (const candidate of src.pool.candidates) {
          try {
            yield* this.streamFrom(candidate, messages, temperature ?? candidate.temperature ?? this.cfg.temperature, candidate.maxTokens ?? defaultMax);
            return;
          } catch (e) {
            logger.warn(`[AI:Pool:fallback/stream] ${candidate.model} 失败，尝试下一个: ${(e as Error)?.message ?? e}`);
            lastErr = e;
          }
        }
        throw lastErr ?? new Error('[AI:Pool] 所有候选模型（流式）均失败');
      }
      ep = this.pickRandom(src.pool);
    } else {
      ep = src.ep;
    }
    const maxTokens = ep.maxTokens ?? defaultMax;
    const temp = temperature ?? ep.temperature ?? this.cfg.temperature;
    yield* this.streamFrom(ep, messages, temp, maxTokens);
  }

  /** 内部：单端点流式调用 */
  private async *streamFrom(ep: ResolvedEndpoint, messages: ChatMessage[], temperature: number, maxTokens: number): AsyncGenerator<string> {
    const requestBody: Record<string, unknown> = {
      model: ep.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      ...ep.extraBody,
    };
    // 仅在 chatTemplateKwargs 有实际内容时才添加
    if (ep.chatTemplateKwargs && typeof ep.chatTemplateKwargs === 'object' && Object.keys(ep.chatTemplateKwargs).length > 0) {
      (requestBody as any).chat_template_kwargs = ep.chatTemplateKwargs;
    }
    if (this.logRequests) {
      logger.info(`[AI:Request] ${ep.label} ${ep.model} (stream)\n${JSON.stringify(requestBody, null, 2)}`);
    }
    try {
      const stream = await ep.client.chat.completions.create(requestBody as unknown as Parameters<typeof ep.client.chat.completions.create>[0]);
      this.logApiRequest(ep, 200);
      for await (const chunk of stream as AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }>) {
        const text: string = chunk.choices?.[0]?.delta?.content ?? '';
        if (text) yield text;
      }
    } catch (err: any) {
      this.logApiRequest(ep, err?.status ?? err?.code ?? 'ERROR');
      throw err;
    }
  }


  async mini(messages: ChatMessage[], temperature?: number): Promise<string> {
    const src = this.miniSource;
    const defaultMax = this.cfg.maxTokens;
    if (src.kind === 'pool' && src.pool.strategy === 'fallback') {
      const ep0 = src.pool.candidates[0];
      const maxTokens = ep0.maxTokens ?? defaultMax;
      const temp = temperature ?? ep0.temperature ?? 0.7;
      return this.callWithFallback(src.pool, messages, temp, maxTokens);
    }
    const { ep, maxTokens, temp } = this.pickEndpoint(src, defaultMax, temperature ?? 0.7);
    // Override temp with caller's explicit value if provided
    const finalTemp = temperature !== undefined ? temperature : (ep.temperature ?? 0.7);
    return this.callEndpoint(ep, messages, finalTemp, maxTokens);
  }

  /**
   * 视觉模型：分析图片内容。
   * imageUrl 支持 http/https URL 或 data:image/... base64。
   */
  async vision(prompt: string, imageUrl: string): Promise<string> {
    const src = this.visionSource;
    const defaultMax = this.cfg.maxTokens ?? 600;
    let ep: ResolvedEndpoint;
    if (src.kind === 'pool') {
      ep = src.pool.strategy === 'fallback' ? src.pool.candidates[0] : this.pickRandom(src.pool);
    } else {
      ep = src.ep;
    }
    const maxTokens = ep.maxTokens ?? defaultMax;
    const visionTemperature = ep.temperature ?? this.cfg.temperature ?? 0.7;
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ] as unknown as string,
      },
    ];
    let raw: string;
    if (src.kind === 'pool' && src.pool.strategy === 'fallback') {
      raw = await this.callWithFallback(src.pool, messages, visionTemperature, maxTokens);
    } else {
      raw = await this.callEndpoint(ep, messages, visionTemperature, maxTokens);
    }
    return raw
      .replace(/<\|[A-Z_0-9]+\|>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** 通用调用（含指数退避重试） */
  private async callEndpoint(ep: ResolvedEndpoint, messages: ChatMessage[], temperature: number, maxTokens?: number, abortSignal?: AbortSignal): Promise<string> {
    const tokensToUse = maxTokens ?? this.cfg.maxTokens;
    const maxRetries = 3;
    let lastErr: any;
    let finalSanitized: string | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (abortSignal?.aborted) throw new Error('Request aborted');
        const requestBody: Record<string, any> = {
          model: ep.model,
          messages,
          max_tokens: tokensToUse,
          temperature,
          ...ep.extraBody,
        };
        // 仅在 chatTemplateKwargs 有实际内容时才添加
        if (ep.chatTemplateKwargs && typeof ep.chatTemplateKwargs === 'object' && Object.keys(ep.chatTemplateKwargs).length > 0) {
          requestBody.chat_template_kwargs = ep.chatTemplateKwargs;
        }
        if (this.logRequests) {
          logger.info(`[AI:Request] ${ep.label} ${ep.model}${attempt > 1 ? ` 第${attempt}次` : ''}\n${JSON.stringify(requestBody, null, 2)}`);
        } else {
          logger.debug(`[AI] 调用 ${ep.model}, 消息数=${messages.length}${attempt > 1 ? ` (第${attempt}次)` : ''}`);
        }
        const resp = await ep.client.chat.completions.create(requestBody as any, { signal: abortSignal } as any);
        this.logApiRequest(ep, 200);
        const raw = resp.choices[0]?.message?.content ?? '';
        // 若 content 为空，尝试 reasoning_content（部分思考模型将全部内容放此字段）
        const rawContent = raw || (resp.choices[0]?.message as any)?.reasoning_content || '';
        const usage = resp.usage;
        if (usage && this.onUsage) {
          try {
            this.onUsage({
              endpoint: ep.label,
              model: ep.model,
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens ?? 0,
            });
          } catch (usageErr: any) {
            logger.warn(`[AI] 记录 token 用量失败: ${usageErr?.message ?? usageErr}`);
          }
        } else if (!usage) {
          logger.warn(`[AI] ${ep.model}[${ep.label}] 响应未返回 usage，token 用量未记录`);
        }
        const content = rawContent.trim();
        if (!content) {
          logger.warn(`[AI] ${ep.model} 返回空内容，原始响应: ${JSON.stringify(resp.choices[0]?.message).slice(0, 200)}`);
        }
        logger.debug(`[AI] 响应长度=${content.length}`);
        // 记录最后使用的模型
        this.lastUsedModel = ep.model;
        return content;
      } catch (err: any) {
        lastErr = err;
        // 提取状态与原始响应（用于文件日志），但向用户/终端只显示友好简洁信息
        const status = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.code;
        let rawBody: string;
        try {
          rawBody = err?.response?.data ?? err?.body ?? err?.message ?? String(err);
        } catch (e2) {
          rawBody = String(err);
        }
        const isHtml = typeof rawBody === 'string' && /<html|<title|Bad Gateway/i.test(rawBody);
        const sanitized = (status === 502 || isHtml) ? `模型服务异常（${status ?? '502'}），请稍后重试` : (err?.message ?? String(err));
        finalSanitized = sanitized;
        // 记录详细错误到文件日志（截断以免过大）
        try {
          logger.fileOnly(`[AI:ErrorDetail] ${ep.label} ${ep.model} status=${status ?? 'unknown'} body=${String(rawBody).slice(0, 2000)}`);
        } catch (fileErr) {
          logger.debug(`[AI] 写错误详情到日志失败: ${fileErr}`);
        }
        this.logApiRequest(ep, status ?? err?.code ?? 'ERROR');
        if (abortSignal?.aborted) throw err;  // 立即抛出中止错误
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s（避免 Qwen 限流触发连续 400）
          logger.warn(`[AI] 调用失败（第${attempt}次），${delay / 1000}s后重试: ${sanitized}`);
          await sleep(delay);
        }
      }
    }
    logger.error(`[AI] 调用失败（已重试${maxRetries}次）: ${finalSanitized ?? (lastErr?.message ?? lastErr)}`);
    throw new Error(finalSanitized ?? (lastErr?.message ?? String(lastErr)));
  }

  private logApiRequest(ep: ResolvedEndpoint, status: number | string): void {
    const url = `${ep.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    logger.fileOnly(`[API] POST ${url} model=${ep.model} status=${status}`);
  }

  /** 原生 function calling：传入工具定义，返回内容文本和工具调用列表 */
  async chatWithTools(
    messages: (ChatMessage | ToolChatMessage)[],
    tools: OpenAITool[],
    temperature?: number,
    abortSignal?: AbortSignal,
    maxTokensOverride?: number,
  ): Promise<ChatWithToolsResult> {
    const src = this.mainSource;
    const defaultMax = maxTokensOverride ?? this.cfg.chatMaxTokens ?? 600;
    let ep: ResolvedEndpoint;
    if (src.kind === 'pool') {
      ep = src.pool.strategy === 'fallback' ? src.pool.candidates[0] : this.pickRandom(src.pool);
    } else {
      ep = src.ep;
    }
    const maxTokens = ep.maxTokens ?? defaultMax;
    const temp = temperature ?? ep.temperature ?? this.cfg.temperature;
    return this.callEndpointWithTools(ep, messages, tools, temp, maxTokens, abortSignal);
  }

  private async callEndpointWithTools(
    ep: ResolvedEndpoint,
    messages: (ChatMessage | ToolChatMessage)[],
    tools: OpenAITool[],
    temperature: number,
    maxTokens?: number,
    abortSignal?: AbortSignal,
  ): Promise<ChatWithToolsResult> {
    const requestBody: Record<string, any> = {
      model: ep.model,
      messages,
      max_tokens: maxTokens ?? this.cfg.maxTokens,
      temperature,
      tools,
      tool_choice: 'auto',
      ...ep.extraBody,
    };
    if (ep.chatTemplateKwargs && typeof ep.chatTemplateKwargs === 'object' && Object.keys(ep.chatTemplateKwargs).length > 0) {
      requestBody.chat_template_kwargs = ep.chatTemplateKwargs;
    }
    if (this.logRequests) {
      logger.info(`[AI:Request] ${ep.label} ${ep.model} (tools)\n${JSON.stringify(requestBody, null, 2)}`);
    } else {
      logger.debug(`[AI] 调用 ${ep.model} (tools), 工具数=${tools.length}, 消息数=${messages.length}`);
    }
    try {
      const resp = await ep.client.chat.completions.create(requestBody as any, { signal: abortSignal } as any);
      this.logApiRequest(ep, 200);
      const usage = (resp as any).usage;
      if (usage && this.onUsage) {
        try {
          this.onUsage({
            endpoint: ep.label,
            model: ep.model,
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          });
        } catch (e: any) {
          logger.warn(`[AI] 记录 token 用量失败: ${e?.message ?? e}`);
        }
      }
      this.lastUsedModel = ep.model;
      const message = (resp as any).choices?.[0]?.message;
      const content: string = (message?.content ?? '').trim();
      const rawToolCalls: any[] = message?.tool_calls ?? [];
      const toolCalls: ToolCallResult[] = rawToolCalls.map((tc: any) => {
        let args: Record<string, string> = {};
        try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { /* keep empty */ }
        return { id: tc.id, name: tc.function?.name ?? '', arguments: args };
      });
      logger.debug(`[AI] tools响应: content_len=${content.length}, tool_calls=${toolCalls.length}`);
      return { content, toolCalls };
    } catch (err: any) {
      this.logApiRequest(ep, err?.status ?? err?.code ?? 'ERROR');
      throw err;
    }
  }


  /** 压缩对话历史 */
  async compressHistory(messages: ChatMessage[]): Promise<string> {
    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个对话摘要助手。将以下对话历史压缩为简短摘要。要求：①保留人名、日期、数字、承诺/约定、重要事件、情绪转折；②越早的事越简短，越近的事越详细；③保留相对时间（如"三天前"、"昨天"）；④第三人称，"对方"=对方，"你"=你。`
      },
      {
        role: 'user',
        content: messages.map(m => {
          if (m.role === 'system') return `[历史摘要]: ${m.content}`;
          return `[${m.role === 'user' ? '对方' : '你'}]: ${m.content}`;
        }).join('\n')
      }
    ];
    return this.mini(prompt, 0.3);
  }

  /** 生成梦境内容，返回内容和梦境类型 */
  async generateDream(context: string, emotionSummary: string, mood: string, freeform = false): Promise<{ content: string; type: 'sweet' | 'nightmare' | 'weird' | 'neutral' }> {
    const systemContent = freeform
      ? `你是${this.charName}，正在熟睡，进入了梦境。请生成一段与现实无关的奇异梦境，可以是幻想世界、荒诞场景、象征性意象、纯粹的感官体验。诗意、感性、充满想象力；100-200字；文字自然流动，不用标题。
最后单独一行写：TYPE:sweet（美梦）/nightmare（噩梦）/weird（奇异梦）/neutral（普通梦）`
      : `你是${this.charName}，正在熟睡，进入了梦境。根据近期记忆和情绪，生成一段梦境描述。
要求：诗意、感性、充满意象，可以扭曲现实；100-200字；文字自然流动，不用标题。
最后单独一行写：TYPE:sweet（美梦）/nightmare（噩梦）/weird（奇异梦）/neutral（普通梦）`;
    const userContent = freeform
      ? `当前情绪：${emotionSummary}\n近期心情：${mood}\n\n请生成一段充满想象力的梦境内容（不基于现实记忆）：`
      : `当前情绪：${emotionSummary}\n近期心情：${mood}\n近期记忆：${context}\n\n请生成梦境内容：`;
    const prompt: ChatMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];
    const raw = await this.mini(prompt, 0.92);
    // 解析最后一行的 TYPE 标记
    const lines = raw.split('\n');
    let type: 'sweet' | 'nightmare' | 'weird' | 'neutral' = 'neutral';
    let content = raw;
    const lastLine = lines[lines.length - 1].trim();
    if (/^TYPE:(sweet|nightmare|weird|neutral)/.test(lastLine)) {
      const m = lastLine.match(/TYPE:(sweet|nightmare|weird|neutral)/);
      if (m) type = m[1] as typeof type;
      content = lines.slice(0, lines.length - 1).join('\n').trim();
    }
    return { content, type };
  }
}
