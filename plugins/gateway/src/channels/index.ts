/**
 * 内置聊天平台渠道驱动（Hermes 叫 platform adapter，OpenClaw 叫 channel）。
 *
 * 驱动不是 leo 插件：只由网关注册。新增平台：在 `channels/<id>/index.ts` 导出一个 ChannelDriver，
 * 加到下面的表里，并在 config.ts 的 BUILTIN_CHANNELS 中加上 id；
 * 第三方插件也可以在运行时调用 `ctx.get('gateway').registerChannel(driver)` 接入新平台。
 */
import type { BuiltinChannel } from '../config.js'
import type { ChannelDriver } from '../types.js'
import { feishu } from './feishu/index.js'
import { qq } from './qq/index.js'
import { telegram } from './telegram/index.js'

export const BUILTIN_DRIVERS: Readonly<Record<BuiltinChannel, ChannelDriver>> = {
  telegram,
  feishu,
  qq,
}
