/**
 * 内置渠道（大箱子里的小盒子）。
 *
 * 这些驱动不是 leo 插件，不能单独安装或加载；只有注册层 `leo-plugin-chat-channels` 会把它们注册进来。
 * 新增渠道：在 `channels/<id>/index.ts` 导出一个 ChannelDriver，然后加到下面的表里，
 * 并在 config.ts 的 BUILTIN_CHANNELS 中加上 id。
 */
import type { BuiltinChannel } from '../config.js'
import type { ChannelDriver } from '../types.js'
import { feishu } from './feishu/index.js'
import { qq } from './qq/index.js'
import { telegram } from './telegram/index.js'
import { wechat } from './wechat/index.js'

export const BUILTIN_DRIVERS: Readonly<Record<BuiltinChannel, ChannelDriver>> = {
  qq,
  wechat,
  feishu,
  telegram,
}
