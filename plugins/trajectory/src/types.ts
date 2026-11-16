/**
 * 轨迹的数据模型（插件对外的 JSON 结构，也是网页与 `/trace export` 的格式）。
 *
 * 会话日志的事件类型在这里用最小结构类型描述，不依赖某个 leo-agents 版本的 `SessionEventMap`：
 * 0.2.1 的宿主没有 `tool/start` 等事件，0.2.2（分支 feat/trajectory-log）才有。读取时一律按“可能没有”处理。
 */

/** 会话事件（结构类型，兼容所有 leo-agents 版本） */
export interface RawEvent {
  id: string
  sessionId: string
  seq: number
  type: string
  at: number
  data: any
}

export interface UsageLike {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
  costUsd?: number
}

/** 会话元信息（leo-agents 0.2.2 `session/meta`；旧宿主由插件从现场推断） */
export interface SessionMetaLike {
  origin?: string
  label?: string
  parentSessionId?: string
  parentAgentId?: string
  parentTurnId?: string
  parentToolCallId?: string
  agentId?: string
  model?: string
  extra?: Record<string, unknown>
}

/**
 * 数据从哪来：
 * - `log`：会话日志里的精确记录（新宿主的 tool/start、firstTokenAt 等，或旧宿主也有的事件时间）
 * - `live`：插件运行时从 `agent/event` 现场测得，只在内存里，进程重启后没有
 * - `estimated`：由其他字段推算（如工具结果消息时间 − 工具自报耗时）
 * - `unavailable`：拿不到
 */
export type TimingSource = 'log' | 'live' | 'estimated' | 'unavailable'

export interface Capabilities {
  /** 日志里有 tool/start / tool/end（leo-agents ≥ 0.2.2） */
  toolEvents: boolean
  /** 日志里的 llm/response 带 firstTokenAt */
  ttft: boolean
  /** 日志里有 session/meta */
  sessionMeta: boolean
  /** 会话存储实现了 list() */
  storeList: boolean
}

export interface AttemptFailure {
  attempt: number
  code: string
  message: string
  at: number
  startedAt?: number
}

export interface ChildLink {
  sessionId: string
  /** 'sub-agent' | 'team-member' | 其他 origin */
  origin?: string
  label?: string
  /** 链接依据：meta（session/meta）、result（工具结果 details）、live（运行时捕获）、naming（会话 id 约定） */
  via: 'meta' | 'result' | 'live' | 'naming'
}

export interface ToolCallRecord {
  kind: 'tool'
  callId: string
  name: string
  /** 参数（已脱敏、已截断的 JSON 文本） */
  args: string
  status: 'running' | 'done' | 'not_run'
  isError?: boolean
  errorCode?: string
  /** 结果预览（已脱敏、已截断） */
  result?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
  timing: TimingSource
  /** 进度（tool_update，最近几条，仅运行时） */
  progress?: string[]
  /** 挂在这次调用下的子会话 */
  children: ChildLink[]
}

export interface StepRecord {
  kind: 'step'
  stepId: string
  index: number
  model?: string
  /** llm/request 的时间（上下文已构建，请求即将发出） */
  requestAt?: number
  /** 成功那次尝试的开始时间 */
  startedAt?: number
  firstTokenAt?: number
  /** llm/response 的时间 */
  endedAt?: number
  /** 模型调用总耗时（含重试与退避）= endedAt − requestAt */
  durationMs?: number
  ttftMs?: number
  /** 解码时间 = endedAt − firstTokenAt */
  decodeMs?: number
  timing: TimingSource
  ttftSource: TimingSource
  usage?: UsageLike
  finishReason?: string
  attempts?: number
  failures: AttemptFailure[]
  estimatedTokens?: number
  /** 本次请求包含的消息条数 / 可用工具数 / system 字符数 */
  inputMessages?: number
  inputTools?: number
  systemChars?: number
  /** 模型输出预览 */
  output?: { messageId?: string; text?: string; reasoning?: string; partial?: boolean }
  status: 'running' | 'done' | 'failed'
  tools: ToolCallRecord[]
}

export interface CompactionRecord {
  kind: 'compaction'
  at: number
  strategy: string
  replacesUpTo: string
  summary: string
}

export interface CustomRecord {
  kind: 'custom'
  at: number
  name: string
  data: string
}

export interface TurnRecord {
  turnId: string
  index: number
  startedAt: number
  endedAt?: number
  durationMs?: number
  reason?: string
  usage?: UsageLike
  error?: { code: string; message: string }
  /** 本 turn 的用户输入预览 */
  input?: string
  status: 'running' | 'done'
  steps: StepRecord[]
  /** 压缩与插件自定义记录（按时间） */
  records: (CompactionRecord | CustomRecord)[]
  /** 没有挂到具体工具调用上的子会话 */
  children: ChildLink[]
}

export interface SessionSummary {
  sessionId: string
  label?: string
  origin?: string
  parentSessionId?: string
  createdAt?: number
  updatedAt?: number
  events?: number
  running: boolean
}

export interface SessionTrajectory {
  sessionId: string
  meta: SessionMetaLike
  /** meta 的来源：日志里的 session/meta，或运行时推断 */
  metaSource: 'log' | 'live' | 'none'
  createdAt?: number
  updatedAt?: number
  running: boolean
  capabilities: Capabilities
  usage: UsageLike
  turns: TurnRecord[]
  /** 会话级子会话（无法确定挂在哪次调用下） */
  children: ChildLink[]
  stats: { turns: number; steps: number; toolCalls: number; toolErrors: number; failedAttempts: number; compactions: number; events: number }
}

/** 树形视图：子会话展开 */
export interface TrajectoryTree extends SessionTrajectory {
  childSessions: Record<string, TrajectoryTree>
}

/** 推送给订阅者的更新 */
export interface TrajectoryUpdate {
  sessionId: string
  /** 'event'：会话日志新增；'live'：运行时数据变化（工具开始、首 token 等） */
  kind: 'event' | 'live'
  type: string
  seq?: number
  at: number
}

/** `ctx.get('trajectory')` */
export interface TrajectoryService {
  /** 某个会话的轨迹；depth > 0 时展开子会话（默认 2 层） */
  get(sessionId: string, opts?: { depth?: number }): Promise<TrajectoryTree | undefined>
  /** 已知会话：存储的 list()（leo-agents ≥ 0.2.2）+ 会话目录扫描 + 运行时见过的会话 */
  list(): Promise<SessionSummary[]>
  /** 订阅更新，返回取消函数 */
  subscribe(listener: (u: TrajectoryUpdate) => void): () => void
  /** 网页地址（服务未启动时为 undefined） */
  url(): string | undefined
}
