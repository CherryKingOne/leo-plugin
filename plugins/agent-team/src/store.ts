import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Phase } from './config.js'

export type ProjectStatus = 'running' | 'awaiting_approval' | 'finished' | 'stopped'
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'failed'

export interface TeamTask {
  id: string
  role: string
  title: string
  detail?: string
  phase: Phase
  status: TaskStatus
  /** 成员交付的摘要 */
  result?: string
  /** 交付的产出物文件名 */
  artifacts?: string[]
  verdict?: 'pass' | 'fail'
  notes?: string[]
  createdAt: string
  updatedAt: string
}

export interface PendingGate {
  /** gate：阶段关卡；bounce-limit：QA 打回次数用尽；question：Leader 主动提问 */
  kind: 'gate' | 'bounce-limit' | 'question'
  /** 关卡名（requirements / design / development / qa / acceptance），question 时为 question */
  gate: string
  phase: Phase
  /** Leader 写给用户的总结与问题 */
  question?: string
  /** 已发出 awaiting-approval 事件 */
  notified?: boolean
  at: string
}

export interface MemberRecord {
  /** 持久会话 id：同一项目里成员一直用它，新会话恢复时续上历史 */
  sessionId: string
  model?: string
}

export interface TeamProject {
  id: string
  title: string
  requirement: string
  status: ProjectStatus
  phase: Phase
  /** 当前阶段里已交付的必需角色 */
  delivered: string[]
  bounces: number
  pendingGate?: PendingGate
  /** 待转告 Leader 的消息（用户的审批意见等），下次运行 Leader 时一并发出 */
  inbox: string[]
  /** 团队默认模型（发起时确定） */
  model?: string
  /** 发起团队的 Agent 当时的工具集：成员工具集不会超出它 */
  baseTools?: string[]
  members: Record<string, MemberRecord>
  history: { at: string; event: string; detail?: string }[]
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export interface TeamBoard {
  projectId: string
  nextTaskNo: number
  tasks: TeamTask[]
}

const ARTIFACT_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/

export function validArtifactName(name: string): boolean {
  return ARTIFACT_NAME.test(name) && !name.includes('..')
}

/** 项目目录：<root>/<projectId>/{state.json, board.json, artifacts/} */
export class ProjectStore {
  constructor(readonly root: string) {}

  dir(id: string): string {
    return join(this.root, id)
  }

  artifactsDir(id: string): string {
    return join(this.root, id, 'artifacts')
  }

  async save(project: TeamProject, board: TeamBoard): Promise<void> {
    const dir = this.dir(project.id)
    await mkdir(join(dir, 'artifacts'), { recursive: true })
    await atomicWrite(join(dir, 'state.json'), `${JSON.stringify(project, null, 2)}\n`)
    await atomicWrite(join(dir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`)
  }

  async load(id: string): Promise<{ project: TeamProject; board: TeamBoard } | undefined> {
    if (!/^[\w-]+$/.test(id)) return undefined
    try {
      const project = JSON.parse(await readFile(join(this.dir(id), 'state.json'), 'utf8')) as TeamProject
      const board = await readFile(join(this.dir(id), 'board.json'), 'utf8')
        .then((t) => JSON.parse(t) as TeamBoard)
        .catch((): TeamBoard => ({ projectId: id, nextTaskNo: 1, tasks: [] }))
      return { project, board }
    } catch {
      return undefined
    }
  }

  async ids(): Promise<string[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  }

  async writeArtifact(id: string, name: string, content: string): Promise<string> {
    if (!validArtifactName(name)) throw new Error(`Invalid artifact name "${name}" (letters, digits, . _ -; no paths)`)
    const dir = this.artifactsDir(id)
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await atomicWrite(file, content)
    return file
  }

  async readArtifact(id: string, name: string): Promise<string | undefined> {
    if (!validArtifactName(name)) return undefined
    return readFile(join(this.artifactsDir(id), name), 'utf8').catch(() => undefined)
  }

  async listArtifacts(id: string): Promise<string[]> {
    try {
      return (await readdir(this.artifactsDir(id))).filter((n) => !n.startsWith('.')).sort()
    } catch {
      return []
    }
  }
}

let seq = 0
async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}
