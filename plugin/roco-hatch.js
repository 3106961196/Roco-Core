/**
 * 洛克王国 · 孵蛋 / 生蛋查询（灵蛋所 wiki，无需登录）
 *
 *   #孵蛋 0.28 2.36
 *   #生蛋 喵喵
 *   #生蛋 喵喵 火花
 */
import PluginBase from '#infrastructure/plugins/plugin-base.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { ensureRocoConfig, isHatchEnabled, getHatchBaseUrl } from './merchant/config.js'
import { queryHatch, formatHatchText } from './hatch/query.js'
import {
  parseEggGroupArgs,
  queryEggGroup as fetchEggGroup,
  queryEggPair as fetchEggPair,
  formatEggGroupText,
  formatEggPairText,
} from './hatch/egg-group-query.js'

const LOG_TAG = '孵蛋查询'

const HELP_TEXT = [
  '洛克王国查询用法',
  '孵蛋：#孵蛋 尺寸 重量',
  '  例：#孵蛋 0.28 2.36（米 / 千克）',
  '生蛋：#生蛋 精灵名',
  '  例：#生蛋 喵喵',
  '配对：#生蛋 精灵A 精灵B',
  '  例：#生蛋 喵喵 火花',
  '数据源：luokewangguofudan.wiki',
].join('\n')

/** 从消息里抽出尺寸、重量两个正数 */
export function parseSizeWeight(msg) {
  const text = String(msg || '')
    .replace(/#?孵蛋(查询)?/i, '')
    .replace(/[ｍm米]/gi, ' ')
    .replace(/[ｋk][ｇg]|千克|公斤/gi, ' ')
    .trim()
  const nums = text.match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 2) return null
  return { size: Number(nums[0]), weight: Number(nums[1]) }
}

export class RocoHatch extends PluginBase {
  constructor() {
    super({
      name: '洛克王国-孵蛋查询',
      dsc: '孵蛋预测与生蛋配对（灵蛋所）',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#?孵蛋(查询)?帮助$', fnc: 'help', log: true },
        { reg: '^#?生蛋(查询|配对)?帮助$', fnc: 'help', log: true },
        { reg: '^#?孵蛋(查询)?$', fnc: 'help', log: true },
        { reg: '^#?生蛋(查询|配对)?$', fnc: 'help', log: true },
        { reg: '^#?孵蛋(查询)?\\s+.+', fnc: 'queryHatch', log: true },
        { reg: '^#?生蛋(查询|配对)?\\s+.+', fnc: 'queryEggGroup', log: true },
      ],
    })
  }

  async init() {
    await ensureRocoConfig()
    if (!isHatchEnabled()) return
    RuntimeUtil.makeLog('mark', '插件已启动（孵蛋+生蛋）', LOG_TAG)
  }

  opts() {
    return { baseUrl: getHatchBaseUrl() }
  }

  async help() {
    await this.reply(HELP_TEXT)
    return true
  }

  /** 用法错误时附带完整帮助 */
  async replyUsage(hint) {
    await this.reply(`${hint}\n\n${HELP_TEXT}`)
  }

  async queryHatch() {
    if (!isHatchEnabled()) {
      await this.reply('孵蛋查询未启用')
      return false
    }

    const parsed = parseSizeWeight(this.e.msg)
    if (!parsed) {
      await this.replyUsage('格式不对。孵蛋需要两个数字：尺寸（米）和重量（千克）。')
      return false
    }

    try {
      const result = await queryHatch(parsed.size, parsed.weight, this.opts())
      await this.reply(formatHatchText(result))
      return true
    } catch (err) {
      RuntimeUtil.makeLog('error', `孵蛋查询失败: ${err?.message || err}`, LOG_TAG)
      await this.reply(`查询出错: ${err?.message || err}`)
      return false
    }
  }

  async queryEggGroup() {
    if (!isHatchEnabled()) {
      await this.reply('生蛋查询未启用')
      return false
    }

    const args = parseEggGroupArgs(this.e.msg)
    if (!args) {
      await this.replyUsage('格式不对。生蛋需要精灵名，配对再加第二只。')
      return false
    }

    try {
      if (args.mode === 'pair') {
        const result = await fetchEggPair(args.nameA, args.nameB, this.opts())
        if (!result.ok) {
          await this.replyUsage(result.message)
          return false
        }
        await this.reply(formatEggPairText(result))
      } else {
        const result = await fetchEggGroup(args.name, this.opts())
        if (!result.ok) {
          await this.replyUsage(result.message)
          return false
        }
        await this.reply(formatEggGroupText(result))
      }
      return true
    } catch (err) {
      RuntimeUtil.makeLog('error', `生蛋查询失败: ${err?.message || err}`, LOG_TAG)
      await this.reply(`查询出错: ${err?.message || err}`)
      return false
    }
  }
}
