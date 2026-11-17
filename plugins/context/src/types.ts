/** 会话日志里的一条事件（leo-agents SessionEvent 的最小结构，插件不在运行时 import leo-agents） */
export interface RawEvent {
  id: string
  sessionId: string
  seq: number
  type: string
  at: number
  data: unknown
}

/**
 * 上下文分类（一次请求里每个 token 归到一类）：
 * - system      Agent 自带的 system prompt 与底座片段
 * - injected    插件注入的 system 片段（技能目录、人设、MCP 说明……），按 owner 再拆
 * - tools       工具定义（name + description + 参数 schema）
 * - user        用户消息
 * - answers     模型回复正文
 * - reasoning   模型思考内容（被回传时）
 * - toolCalls   模型发起的工具调用（名字与参数）
 * - toolResults 工具返回的结果
 * - summary     压缩摘要
 */
export type Category = 'system' | 'injected' | 'tools' | 'user' | 'answers' | 'reasoning' | 'toolCalls' | 'toolResults' | 'summary'
export const CATEGORIES: readonly Category[] = ['system', 'injected', 'tools', 'user', 'answers', 'reasoning', 'toolCalls', 'toolResults', 'summary']

export type Composition = Record<Category, number>

/** 数据来源：`log` 日志里的 breakdown（leo-agents ≥ 0.2.3）；`estimate` 插件按同口径推算 */
export type CompositionSource = 'log' | 'estimate'

export interface UsageTotals {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  /** 计费 token = 输入 + 输出 */
  billedTokens: number
  costUsd: number
  /** provider：厂商返回的 costUsd；pricing：按模型价目推算；mixed；none：无价格 */
  costSource: 'provider' | 'pricing' | 'mixed' | 'none'
  /** cachedInputTokens / inputTokens，0..1；没有输入时 undefined */
  cacheHitRate?: number
}

export interface RequestPoint {
  /** 会话内第几次模型请求（从 0 开始） */
  index: number
  at: number
  turnId: string
  stepId: string
  /** 第几个 turn（从 1 开始） */
  turn: number
  model: string
  /** 本地估算的请求大小（leo-agents 的 estimatedTokens） */
  estimatedTokens: number
  composition: Composition
  source: CompositionSource
  messages: number
  tools: number
  /** 模型实际报告的用量（成功时） */
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; costUsd?: number }
  /** 失败的尝试次数 */
  failedAttempts: number
  /** 模型调用耗时（request → response），毫秒 */
  durationMs?: number
  ttftMs?: number
  /** 这次请求前发生了压缩 */
  compacted?: boolean
}

export interface ContextWindowInfo {
  contextWindow: number
  reserveOutputTokens: number
  limitTokens: number
  softLimitTokens: number
  /** log：日志 breakdown；model：模型信息；default：底座默认值（128k / 8192 / 0.85） */
  source: 'log' | 'model' | 'default'
}

export interface CurrentContext {
  requestIndex: number
  at: number
  model: string
  estimatedTokens: number
  composition: Composition
  source: CompositionSource
  /** 插件注入的片段按来源插件拆分 */
  injectedBy: Record<string, number>
  /** system 片段明细（日志有 breakdown 时） */
  sections?: { id: string; layer: string; owner: string; tokens: number }[]
  /** 每个工具定义的 token（日志有 breakdown 时） */
  toolDefs?: Record<string, number>
  window: ContextWindowInfo
  /** estimatedTokens / contextWindow，0..1 */
  occupancy: number
  /** 离自动压缩还剩多少 token（负数表示已超过软阈值） */
  untilCompaction: number
}

export type ContextEventKind = 'compaction' | 'truncation' | 'model' | 'tools' | 'sections' | 'retry' | 'error'

export interface ContextEventRecord {
  kind: ContextEventKind
  at: number
  requestIndex?: number
  /** 一句话说明 */
  text: string
  before?: number
  after?: number
  detail?: Record<string, unknown>
}

export interface ToolStat {
  name: string
  calls: number
  errors: number
  totalMs: number
  argTokens: number
  resultTokens: number
  lastAt: number
}

export type FileOp = 'read' | 'write' | 'edit' | 'list' | 'search'
export interface FileActivity {
  path: string
  ops: Partial<Record<FileOp, number>>
  errors: number
  lastAt: number
}

export interface CommandRun {
  at: number
  callId: string
  command: string
  program: string
  ok: boolean
  durationMs?: number
}

export interface SessionStats {
  turns: number
  steps: number
  userInputs: number
  toolCalls: number
  toolErrors: number
  compactions: number
  failedAttempts: number
  usage: UsageTotals
  timing: {
    /** 所有 turn 的时长合计 */
    activeMs: number
    /** 模型调用（含重试等待） */
    modelMs: number
    /** 工具执行（按 step 取墙钟时间，并发不重复计） */
    toolMs: number
    /** 其余：上下文构建、审批、钩子…… */
    overheadMs: number
    /** 工具耗时来源：log（tool/start/end）、reported（工具自报 durationMs）、none */
    toolSource: 'log' | 'reported' | 'none'
  }
}

export interface SessionMetaLike {
  origin?: string
  label?: string
  parentSessionId?: string
  agentId?: string
  model?: string
}

export interface SessionReport {
  sessionId: string
  createdAt?: number
  updatedAt?: number
  events: number
  meta: SessionMetaLike
  models: string[]
  stats: SessionStats
  current?: CurrentContext
  trend: RequestPoint[]
  contextEvents: ContextEventRecord[]
  tools: ToolStat[]
  files: FileActivity[]
  commands: CommandRun[]
  /** 技能加载（skills 插件的 skill 工具） */
  skills: { name: string; loads: number; lastAt: number }[]
  children: SessionSummary[]
  /** 数据完整度：日志是否带 breakdown、tool/start */
  completeness: { breakdown: boolean; toolTiming: boolean }
}

export interface SessionSummary {
  sessionId: string
  createdAt?: number
  updatedAt?: number
  events: number
  label?: string
  origin?: string
  parentSessionId?: string
  model?: string
  turns?: number
  billedTokens?: number
  costUsd?: number
  /** 最近一次请求的上下文大小与占用率 */
  contextTokens?: number
  occupancy?: number
  composition?: Composition
}

/** 上下文浏览器：某次请求里的一条内容 */
export interface BrowserItem {
  kind: 'section' | 'tool' | 'message'
  id: string
  category: Category
  tokens: number
  /** section：layer / owner；message：role、toolName */
  label: string
  preview: string
}

export interface RequestDetail {
  index: number
  at: number
  model: string
  composition: Composition
  source: CompositionSource
  total: number
  offset: number
  limit: number
  items: BrowserItem[]
}

export interface OverviewDay {
  /** 本地日期 YYYY-MM-DD */
  date: string
  billedTokens: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number
  requests: number
}

export interface Overview {
  generatedAt: number
  rangeDays: number
  kpi: {
    sessions: number
    turns: number
    requests: number
    billedTokens: number
    costUsd: number
    cacheHitRate?: number
    toolCalls: number
    activeMs: number
  }
  /** 最近 7 天（按请求时间归日） */
  last7: OverviewDay[]
  /** 最近 8 周（56 天）每日计费 token */
  heatmap: { date: string; billedTokens: number }[]
  /** 范围内每次请求的上下文组成合计（按估算 token） */
  composition: Composition
  tools: { name: string; calls: number; errors: number; lastAt: number }[]
  skills: { name: string; loads: number; lastAt: number }[]
  programs: { name: string; runs: number; failures: number; lastAt: number }[]
  sessions: SessionSummary[]
  /** 扫描上限被截断时为 true */
  truncated: boolean
}

export interface ContextUpdate {
  sessionId: string
  type: string
  at: number
}

/** `ctx.get('contextInsight')`：给其他插件读上下文报告 */
export interface ContextInsightService {
  report(sessionId: string): Promise<SessionReport | undefined>
  list(): Promise<SessionSummary[]>
  overview(opts?: { days?: number }): Promise<Overview>
  request(sessionId: string, index: number, opts?: { offset?: number; limit?: number; category?: Category }): Promise<RequestDetail | undefined>
  subscribe(listener: (u: ContextUpdate) => void): () => void
  url(): string | undefined
}
