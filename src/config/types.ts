// 所有配置的 TypeScript 类型定义

/** 单个模型端点配置 */
export interface ModelEndpointConfig {
  model?: string;
  pool?: string;     // 引用命名模型集（优先于 model 字段）
  baseUrl?: string;  // 不填则使用全局 api.baseUrl
  apiKey?: string;   // 不填则使用全局 api.apiKey（本地模型可留空）
  temperature?: number;   // 端点级 temperature（覆盖全局值）
  maxTokens?: number;     // 端点级 maxTokens（覆盖全局 maxTokens）
  // 传递给 API 的额外 body 参数（模型专用，直接展开到请求顶层）
  // 例如 llama.cpp: extraBody: { enable_thinking: false }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraBody?: Record<string, any>;
  // GLM4.x 专用：思考模式控制参数（映射为请求顶层 chat_template_kwargs）
  // 例如: chatTemplateKwargs: { enable_thinking: false, clear_thinking: true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chatTemplateKwargs?: Record<string, any> | null;
}

/** 模型集中单个候选模型（继承 ModelEndpointConfig，增加权重字段） */
export interface ModelPoolItem {
  model: string;     // 候选模型名（必填）
  weight?: number;   // 权重，用于 random 策略（默认 1）
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraBody?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chatTemplateKwargs?: Record<string, any> | null;
}

/** 模型集定义 */
export interface ModelPool {
  /** random: 按权重随机选择；fallback: 顺序尝试，失败换下一个 */
  strategy: 'random' | 'fallback';
  models: ModelPoolItem[];
}

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;                 // 全局 Key，本地模型可省略
  model?: string;                  // 全局默认模型（main/mini/vision 未单独指定时继承）
  maxTokens: number;               // 通用最大 token 数（日记、压缩等长文本任务）
  chatMaxTokens?: number;          // 对话回复最大 token 数（默认 600），控制回复不过长
  temperature: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraBody?: Record<string, any>; // 全局额外 body 参数（被端点级同名参数覆盖/合并）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chatTemplateKwargs?: Record<string, any> | null; // 全局 GLM4.x 思考模式控制
  main: ModelEndpointConfig;
  mini?: ModelEndpointConfig;      // 未配置时继承 main 设置
  vision?: ModelEndpointConfig;    // 未配置时继承 main 设置
  /** 命名模型集，供 main/mini/vision 通过 pool 字段引用 */
  modelPools?: Record<string, ModelPool>;
}

export interface HeartbeatConfig {
  intervalMinutes: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  /** 每次心跳获取新闻的概率 (0-1)，默认0.35 */
  newsFetchProbability?: number;
  /** 每次心跳触发随机生活事件的概率 (0-1)，默认0.2 */
  randomEventProbability?: number;
  /** 独立任务监听器检查间隔（秒），默认60。用于精准触发用户提醒，不依赖AI心跳 */
  taskWatchIntervalSeconds?: number;
  /**
   * 系统通知（如"打工回来了"、"Ta去睡觉了"等）是否发送到非CLI信道，默认false
   * true = 广播所有信道；false = 仅CLI
   */
  systemNoticeToAllChannels?: boolean;
  /** CLI是否显示系统通知，默认true */
  systemNoticeInCli?: boolean;
  /** 写日记的最小间隔（小时），默认 3 小时，防止重复写内容相似的日记 */
  diaryMinIntervalHours?: number;
  /** 每天最多写几篇日记，默认 3 */
  diaryMaxPerDay?: number;
}

export interface MemoryConfig {
  shortTermMaxAgeHours: number;
  longTermDecayRatePerDay: number;
  importanceThreshold: number;
  retrievalLimit: number;
  /** 梦境记忆保留时间（小时），超期自动删除，默认48 */
  dreamMemoryTTLHours?: number;
  /** 记忆模糊：decay_factor低于此值时开始第一级模糊（轻度子句遮蔽），默认0.65 */
  blurThreshold1?: number;
  /** 记忆模糊：decay_factor低于此值时第二级模糊（中度子句遮蔽），默认0.4 */
  blurThreshold2?: number;
  /** 记忆模糊：decay_factor低于此值时第三级模糊（重度子句遮蔽），默认0.2 */
  blurThreshold3?: number;
}

export interface EmotionInitialValuesConfig {
  joy?: number;
  sadness?: number;
  anxiety?: number;
  anger?: number;
  fear?: number;
  excitement?: number;
  disgust?: number;
  shame?: number;
  curiosity?: number;
}

export interface EmotionConfig {
  decayRate: number;
  maxValue: number;
  minValue: number;
  neutralValue: number;
  /** 初始情绪值；未填写的维度回退到 neutralValue */
  initialValues?: EmotionInitialValuesConfig;
}

export interface HealthInitialValuesConfig {
  healthValue?: number;
  fatigue?: number;
}

export interface HealthConfig {
  dailyRecovery: number;
  /** 清醒状态下每天自然增长的疲惫值 */
  fatigueDailyIncrease?: number;
  fatigueDailyRecovery: number;
  diseaseProbability: number;
  sleepHealthBonus: number;
  sleepFatigueMinus: number;
  /** 初始健康/疲惫值 */
  initialValues?: HealthInitialValuesConfig;
}

export interface ContextConfig {
  maxMessages: number;
  compressionKeepRecent: number;
  compressionKeepFirst: number;  // 保留最早的N条消息，永不压缩（0=不保留）
  timeMarkerIntervalMinutes?: number;  // 多少分钟间隔后向AI注入时间标记（默认5分钟）
}

export interface MessageConfig {
  minDelayMs: number;
  maxDelayMs: number;
  typingSpeedCharsPerSec: number;
}

export interface EconomyConfig {
  dailyCurrencyUser: number;
  dailyCurrencyAi: number;
}

export interface RelationshipConfig {
  initialAffection: number;
  affectionDecayPerDay: number;
}

export interface SleepConfig {
  startHour: number;
  endHour: number;
  minDurationHours: number;
  maxDurationHours: number;
  dreamProbability: number;
  /** 疲惫达到该值后优先去睡觉 */
  fatigueSleepThreshold?: number;
  /** 疲惫达到该值后强制进入睡眠 */
  fatigueForceSleepThreshold?: number;
}

export interface WorkConfig {
  earningPerHour: number;
  maxHours: number;
  /** 打工每小时额外增加的疲惫值 */
  fatiguePerHour?: number;
}

export interface WeatherConfig {
  enabled: boolean;
  city: string;
  fetchIntervalMinutes: number;
}

export interface NewsConfig {
  enabled?: boolean;           // 是否启用新闻系统
  fetchIntervalHours: number;
  maxItems: number;
  sources: string[];
}

export interface DatabaseConfig {
  path: string;
}

export interface WechatChannelConfig {
  // 目标联系人的 userId（空=接受所有人的消息）
  targetUserId: string;
  // 会话存储目录（用于保持登录状态）
  storageDir: string;
  // 日志级别
  logLevel: string;
  // 最大自动重连次数（默认3）
  maxReconnectAttempts?: number;
}

export interface FeishuChannelConfig {
  // 飞书应用 App ID
  appId: string;
  // 飞书应用 App Secret
  appSecret: string;
  // 目标用户的 open_id（空=接受首条消息的发送者）
  targetUserId: string;
}

export interface QQChannelConfig {
  // QQ 官方机器人 AppID
  appId: string;
  // QQ 官方机器人 AppSecret（用于获取 Access Token，替代已废弃的 Token 鉴权）
  appSecret: string;
  // 目标用户 openid（空=自动绑定首条私信/C2C 消息的发送者）
  targetOpenId?: string;
  // 是否使用沙箱环境（测试期间设为 true）
  sandbox?: boolean;
}

export interface ChannelsConfig {
  enabled: string[];
  wechat: WechatChannelConfig;
  feishu?: FeishuChannelConfig;
  qq?: QQChannelConfig;
}

export interface LogConfig {
  level: string;
  showTimestamp: boolean;
  logDir?: string;             // 日志文件目录（为空则不写文件）
  retentionDays?: number;      // 日志保留天数（默认 30 天，超期自动删除）
}

export interface AppConfig {
  api: ApiConfig;
  heartbeat: HeartbeatConfig;
  memory: MemoryConfig;
  emotion: EmotionConfig;
  health: HealthConfig;
  context: ContextConfig;
  message: MessageConfig;
  economy: EconomyConfig;
  relationship: RelationshipConfig;
  sleep: SleepConfig;
  work: WorkConfig;
  news: NewsConfig;
  database: DatabaseConfig;
  channels: ChannelsConfig;
  log: LogConfig;
  weather?: WeatherConfig;
  debug?: boolean;   // 开启调试模式，解锁 /debug 命令组
  showActionSummary?: boolean;  // 显示已执行的行动摘要
}

export interface CharacterConfig {
  name: string;
  gender: string;
  age: number;
  profession: string;
  personality: string[];
  background: string;
  interests: string[];
  speakingStyle: string;
  systemPromptBase: string;
  userAlias?: string;  // 用户的称呼（如"对方"、"他"、"小明"），心跳消息中使用
  initialState?: {
    affection?: number;
    healthValue?: number;
    fatigue?: number;
    emotions?: EmotionInitialValuesConfig;
  };
}

export interface FullConfig {
  app: AppConfig;
  character: CharacterConfig;
}
