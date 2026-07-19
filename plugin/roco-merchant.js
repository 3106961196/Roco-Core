/**
 * 洛克王国 · 远行商人
 *
 *   - 定时：PluginBase.task（PUSH_CRON / CACHE_CRON）
 *   - 抓取：PlaywrightAgentSession + buildBrowserRuntime
 *   - 渲染：RendererLoader + resources/远行商人/merchant.html
 *   - 推送目标：配置 pushGroupIds + 指令预约（私聊/额外群）
 *   - 配置 CommonConfigRegistry(roco)
 */
import PluginBase from '#infrastructure/plugins/plugin-base.js'
import RuntimeUtil from '#utils/runtime-util.js'
import paths from '#utils/paths.js'
import path from 'node:path'
import {
  ensureRocoConfig,
  isPushEnabled,
  getPushGroupIds,
  isMerchantEnabled,
} from './merchant/config.js'
import {
  getCurrentSlot,
  isOvernightSlot,
  dayKey,
  fetchMerchantViewData,
  waitForReadyShelf,
  cacheTodayExclusiveSlots,
} from './merchant/crawl.js'
import { renderMerchantImage, formatTextFallback } from './merchant/view.js'

const LOG_TAG = '远行商人'
const PUSH_CRON = '0 1 8,12,16,20 * * *'
const CACHE_CRON = '0 58 23 * * *'
const PUSH_DEDUP_PREFIX = 'AGT:roco-merchant:pushed'
const SUBS_CACHE = 'roco-merchant-subs'

const nowLabel = () =>
  new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

export class RocoMerchant extends PluginBase {
  pushInFlight = false

  constructor() {
    super({
      name: '洛克王国-远行商人',
      dsc: '远行商人查询与预约推送',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#?远行商人$', fnc: 'queryMerchant', log: true },
        { reg: '^#?远行商人(订阅|预约)$', fnc: 'subscribeMerchant', log: true },
        { reg: '^#强制刷新远行人$', fnc: 'forceRefresh', permission: 'master', log: true },
        { reg: '^#?远行商人状态$', fnc: 'showStatus', permission: 'master', log: true },
        { reg: '^#?远行商人取消(订阅|预约)$', fnc: 'unsubscribeMerchant', permission: 'master', log: true },
        { reg: '^#?远行商人(订阅|预约)列表$', fnc: 'listSubscriptions', permission: 'master', log: true },
        { reg: '^#?远行商人推送测试$', fnc: 'testPush', permission: 'master', log: true },
      ],
      task: [
        { name: '远行商人推送', cron: PUSH_CRON, fnc: 'pushScheduled', log: true, timezone: 'Asia/Shanghai' },
        { name: '远行商人专属缓存', cron: CACHE_CRON, fnc: 'cacheExclusiveDaily', log: true, timezone: 'Asia/Shanghai' },
      ],
    })
  }

  get subsFile() {
    return path.join(paths.data, 'Roco-data', 'subscription', 'subscriptions.json')
  }

  get subsCache() {
    return RuntimeUtil.getMap(SUBS_CACHE)
  }

  async init() {
    await ensureRocoConfig()
    if (!isMerchantEnabled()) return
    await this.loadSubscriptions()
    RuntimeUtil.makeLog('mark', `插件已启动，配置推送群 ${getPushGroupIds().length} 个`, LOG_TAG)
  }

  /** 配置群 + 指令预约目标（群去重，配置群优先） */
  getPushTargets() {
    const seen = new Set()
    const targets = []
    for (const id of getPushGroupIds()) {
      if (seen.has(`group:${id}`)) continue
      seen.add(`group:${id}`)
      targets.push({ type: 'group', id, from: 'config' })
    }
    for (const sub of this.subsCache.values()) {
      const key = `${sub.type}:${sub.id}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ ...sub, from: 'book' })
    }
    return targets
  }

  async queryMerchant() {
    try {
      const view = await fetchMerchantViewData()
      const buf = await renderMerchantImage(view)
      await this.reply(buf ? msgSegment.image(buf) : formatTextFallback(view))
      return true
    } catch (err) {
      RuntimeUtil.makeLog('error', `查询失败: ${err?.message || err}`, LOG_TAG)
      await this.reply(`查询出错: ${err?.message || err}`)
      return false
    }
  }

  async forceRefresh() {
    try {
      await this.reply('正在强制刷新远行商人数据...')
      const view = await fetchMerchantViewData()
      const buf = await renderMerchantImage(view)
      await this.reply(buf ? msgSegment.image(buf) : formatTextFallback(view))
      return true
    } catch (err) {
      await this.reply(`刷新失败: ${err?.message || err}`)
      return false
    }
  }

  async showStatus() {
    const slot = getCurrentSlot()
    const e = this.e
    const isGroup = !!e?.isGroup
    const id = isGroup ? String(e.group_id) : String(e.user_id)
    const cfgGroups = getPushGroupIds()
    const inConfig = isGroup && cfgGroups.includes(id)
    const booked = this.subsCache.has(`${isGroup ? 'group' : 'private'}:${id}`)

    let msg = [
      '远行商人推送状态',
      '--------------------',
      `当前时间：${nowLabel()}`,
      `时段：${slot.label}`,
      `状态：${isOvernightSlot(slot) ? '闭市' : '开市'}`,
      `推送：${isPushEnabled() ? '已启用' : '未启用'}`,
      `配置群：${cfgGroups.length ? cfgGroups.join('、') : '（空，请在 roco.yaml 填写 pushGroupIds）'}`,
      `指令预约：${this.subsCache.size} 个`,
    ].join('\n')

    if (isGroup) {
      if (inConfig) msg += `\n\n本群：已在配置 pushGroupIds 中，到点自动推送`
      else if (booked) msg += `\n\n本群：已指令预约`
      else msg += `\n\n本群：未预约\n发送 #远行商人预约 或把群号写入配置 pushGroupIds`
    } else if (booked) {
      msg += `\n\n你：已指令预约私聊推送`
    } else {
      msg += `\n\n你：未预约\n发送 #远行商人预约 可预约私聊推送`
    }

    await this.reply(msg)
    return true
  }

  /** 预约：群已在配置则提示；否则写入指令预约列表 */
  async subscribeMerchant() {
    if (!isPushEnabled()) {
      await this.reply('推送功能未启用，请联系管理员开启')
      return false
    }
    const sub = this.buildSubFromEvent()
    if (!sub) {
      await this.reply('无法识别目标，请稍后重试')
      return false
    }

    if (sub.type === 'group' && getPushGroupIds().includes(sub.id)) {
      await this.reply('本群已在配置 pushGroupIds 中，无需再预约，到点会自动推送')
      return true
    }

    const key = `${sub.type}:${sub.id}`
    if (this.subsCache.has(key)) {
      await this.reply(sub.type === 'group' ? '本群已预约过了' : '你已预约过了')
      return true
    }

    this.subsCache.set(key, sub)
    await this.saveSubscriptions()
    await this.reply(
      sub.type === 'group'
        ? '本群已预约远行商人推送（也可把群号写入配置 pushGroupIds 永久生效）'
        : '已预约远行商人私聊推送',
    )
    return true
  }

  async unsubscribeMerchant() {
    const sub = this.buildSubFromEvent()
    if (!sub) {
      await this.reply('无法识别目标')
      return false
    }

    if (sub.type === 'group' && getPushGroupIds().includes(sub.id)) {
      await this.reply('本群在配置 pushGroupIds 中，请从 data/Roco-data/roco.yaml 移除群号')
      return true
    }

    const key = `${sub.type}:${sub.id}`
    if (!this.subsCache.has(key)) {
      await this.reply('未预约')
      return true
    }
    this.subsCache.delete(key)
    await this.saveSubscriptions()
    await this.reply(sub.type === 'group' ? '本群已取消预约' : '已取消预约')
    return true
  }

  async listSubscriptions() {
    const cfgGroups = getPushGroupIds()
    const booked = [...this.subsCache.values()]
    let msg = '远行商人推送目标\n--------------------\n'
    msg += `【配置群 pushGroupIds】共 ${cfgGroups.length}\n`
    if (!cfgGroups.length) msg += '（空）\n'
    else cfgGroups.forEach((id, i) => { msg += `${i + 1}. [群] ${id}\n` })

    msg += `\n【指令预约】共 ${booked.length}\n`
    if (!booked.length) msg += '（空）'
    else {
      booked.forEach((s, i) => {
        msg += `${i + 1}. [${s.type === 'group' ? '群' : '私'}] ${s.id} - ${s.subscribedAt || ''}\n`
      })
    }
    await this.reply(msg)
    return true
  }

  async testPush() {
    const targets = this.getPushTargets()
    if (!targets.length) {
      await this.reply('无推送目标：请在 roco.yaml 填写 pushGroupIds，或先 #远行商人预约')
      return false
    }
    await this.reply(`开始推送测试，共 ${targets.length} 个目标...`)
    const result = await this.deliverToTargets(await fetchMerchantViewData(), targets)
    await this.reply(`推送测试完成\n总计: ${result.total}\n成功: ${result.success}\n失败: ${result.failed}`)
    return true
  }

  async cacheExclusiveDaily() {
    if (!isMerchantEnabled()) return
    try {
      await cacheTodayExclusiveSlots(new Date())
    } catch (err) {
      RuntimeUtil.makeLog('error', `专属缓存失败: ${err?.message || err}`, LOG_TAG)
    }
  }

  async pushScheduled() {
    if (!isMerchantEnabled() || !isPushEnabled()) return
    if (this.pushInFlight) {
      RuntimeUtil.makeLog('mark', '上一次推送仍在进行，跳过', LOG_TAG)
      return
    }

    const targets = this.getPushTargets()
    if (!targets.length) {
      RuntimeUtil.makeLog('mark', '无推送目标（pushGroupIds / 预约均为空），跳过', LOG_TAG)
      return
    }

    const slot = getCurrentSlot()
    if (isOvernightSlot(slot)) {
      RuntimeUtil.makeLog('mark', '当前闭市，跳过推送', LOG_TAG)
      return
    }
    if (await this.hasPushedSlot(slot)) {
      RuntimeUtil.makeLog('mark', `${slot.label} 今日已推送，跳过`, LOG_TAG)
      return
    }

    this.pushInFlight = true
    try {
      const view = await waitForReadyShelf(slot)
      if (!view || (await this.hasPushedSlot(slot))) return
      const result = await this.deliverToTargets(view, targets)
      if (result.success > 0) await this.markPushedSlot(slot)
    } catch (err) {
      RuntimeUtil.makeLog('error', `定时推送失败: ${err?.message || err}`, LOG_TAG)
    } finally {
      this.pushInFlight = false
    }
  }

  async deliverToTargets(view, targets) {
    const buf = await renderMerchantImage(view)
    const payload = buf ? msgSegment.image(buf) : formatTextFallback(view)
    let success = 0
    let failed = 0

    for (const t of targets) {
      try {
        await this.deliver(t, payload)
        success++
        await RuntimeUtil.sleep(500)
      } catch (err) {
        failed++
        RuntimeUtil.makeLog('error', `推送失败 ${t.type}(${t.id}): ${err?.message || err}`, LOG_TAG)
      }
    }
    return { total: targets.length, success, failed }
  }

  async deliver(sub, msg) {
    if (sub.type === 'group') {
      await AgentRuntime.sendGroupMsg(sub.uin || null, sub.id, msg)
    } else {
      await AgentRuntime.sendFriendMsg(sub.uin || null, sub.id, msg)
    }
  }

  pushDedupKey(slot, now = new Date()) {
    return `${PUSH_DEDUP_PREFIX}:${dayKey(now)}:${slot.key}`
  }

  async hasPushedSlot(slot, now = new Date()) {
    if (!globalThis.redis?.isOpen) return false
    try {
      return !!(await redis.get(this.pushDedupKey(slot, now)))
    } catch {
      return false
    }
  }

  async markPushedSlot(slot, now = new Date()) {
    if (!globalThis.redis?.isOpen) return
    try {
      await redis.set(this.pushDedupKey(slot, now), '1', { EX: 36 * 3600 })
    } catch (err) {
      RuntimeUtil.makeLog('warn', `写入推送去重失败: ${err?.message || err}`, LOG_TAG)
    }
  }

  buildSubFromEvent() {
    const e = this.e
    if (!e) return null
    const isGroup = !!e.group_id
    const id = isGroup ? String(e.group_id) : String(e.user_id)
    if (!id || id === 'undefined') return null
    return {
      type: isGroup ? 'group' : 'private',
      id,
      subscribedBy: String(e.user_id || ''),
      subscribedAt: nowLabel(),
      uin: e.self_id ? String(e.self_id) : null,
    }
  }

  async loadSubscriptions() {
    try {
      const data = JSON.parse(await RuntimeUtil.readFile(this.subsFile))
      for (const sub of data.subscriptions || []) {
        if (sub?.type && sub?.id) this.subsCache.set(`${sub.type}:${sub.id}`, sub)
      }
    } catch { /* 首次启动 */ }
  }

  async saveSubscriptions() {
    await RuntimeUtil.writeFile(this.subsFile, JSON.stringify({
      subscriptions: [...this.subsCache.values()],
      updatedAt: new Date().toISOString(),
    }, null, 2))
  }
}

export default RocoMerchant
