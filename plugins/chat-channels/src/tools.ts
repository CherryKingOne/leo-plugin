import type { ToolDefinition, ToolOutput } from 'leo-agents'
import { z } from 'zod'
import type { ChatChannelService } from './types.js'

/** 等价于 leo-agents 的 toolOutput()；插件不运行时依赖 leo-agents（见 PROTOCOL.md 第 3 节） */
const output = (out: ToolOutput): ToolOutput => Object.assign(out, { [Symbol.for('leo.toolOutput')]: true })

export function createListTool(service: () => ChatChannelService): ToolDefinition<Record<string, never>> {
  return {
    name: 'chat_channels',
    title: 'Chat channels',
    description:
      'List the chat channels (QQ, Feishu, Telegram, ...) and the bot accounts configured on them, with their state. Use it before chat_send to find a valid account id. Read-only.',
    parameters: z.object({}),
    execute() {
      const s = service()
      return { drivers: s.drivers().map((d) => ({ id: d.id, name: d.name, receive: d.receive })), accounts: s.accounts() }
    },
  }
}

export function createSendTool(service: () => ChatChannelService): ToolDefinition<{ account: string; chat_id: string; chat_type?: 'direct' | 'group' | 'channel'; text: string; reply_to?: string }> {
  return {
    name: 'chat_send',
    title: 'Send chat message',
    description:
      'Send a text message through a configured chat bot account (QQ, Feishu, Telegram). Use only when the user explicitly asks you to message someone; do not use it to reply to the conversation you are currently in (that happens automatically). Long text is split automatically. Returns the message ids.',
    parameters: z.object({
      account: z.string().min(1).describe('Bot account id from chat_channels'),
      chat_id: z.string().min(1).describe('Target chat id on that channel (Telegram chat_id, Feishu chat_id/open_id, QQ openid/group_openid/channel_id)'),
      chat_type: z.enum(['direct', 'group', 'channel']).optional().describe('Kind of chat; needed for QQ when it is not a direct chat'),
      text: z.string().min(1).max(20_000).describe('Plain-text message'),
      reply_to: z.string().optional().describe('Channel message id to reply to (QQ requires it for passive replies)'),
    }),
    permissions: [{ kind: 'chat.send', sideEffect: true }],
    async execute({ account, chat_id, chat_type, text, reply_to }, exec) {
      try {
        const r = await service().send(account, { chatId: chat_id, ...(chat_type ? { chatType: chat_type } : {}) }, { text, ...(reply_to ? { replyTo: reply_to } : {}) }, exec.signal)
        return output({ content: `Sent (${r.messageIds.length || 1} message${r.messageIds.length > 1 ? 's' : ''}).`, details: r })
      } catch (err) {
        return output({ content: `Send failed: ${(err as Error).message}`, isError: true })
      }
    },
  }
}
