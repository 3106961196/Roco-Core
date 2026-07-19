/**
 * 洛克王国 · 远行商人
 *
 *   - 定时：PluginBase.task（PUSH_CRON / CACHE_CRON）
 *   - 抓取：PlaywrightAgentSession + buildBrowserRuntime
 *   - 渲染：RendererLoader + resources/远行商人/merchant.html
 *   - 去重 redis / 专属缓存 sqliteKv
 *   - 配置 CommonConfigRegistry(roco) ← default/roco.yaml → data/Roco-data/roco.yaml
 */
import PluginBase from '#infrastructure/plugins/plugin-base.js'
import RuntimeUtil from '#utils/runtime-util.js'
import paths from '#utils/paths.js'
import path from 'node:path'
import {
  ensureRocoConfig,
  isPushEnabled,
  getMaxSubscriptionsPerTarget,
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
      dsc: '远行商人查询与订阅推送',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#?远行商人$', fnc: 'queryMerchant', log: true },
        { reg: '^#?远行商人订阅$', fnc: 'subscribeMerchant', log: true },
        { reg: '^#强制刷新远行人$', fnc: 'forceRefresh', permission: 'master', log: true },
        { reg: '^#?远行商人状态$', fnc: 'showStatus', permission: 'master', log: true },
        { reg: '^#?远行商人取消订阅$', fnc: 'unsubscribeMerchant', permission: 'master', log: true },
        { reg: '^#?远行商人订阅列表$', fnc: 'listSubscriptions', permission: 'master', log: true },
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
    RuntimeUtil.makeLog('mark', '插件已启动', LOG_TAG)
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
    const sub = this.subsCache.get(`${isGroup ? 'group' : 'private'}:${id}`)

    let msg = [
      '远行商人订阅状态',
      '--------------------',
      `当前时间：${nowLabel()}`,
      `时段：${slot.label}`,
      `状态：${isOvernightSlot(slot) ? '闭市' : '开市'}`,
      `推送：${isPushEnabled() ? '已启用' : '未启用'}`,
      `订阅数：${this.subsCache.size}`,
    ].join('\n')

    msg += sub
      ? `\n\n本${isGroup ? '群' : '你'}：已订阅（${sub.subscribedAt || ''}）`
      : `\n\n本${isGroup ? '群' : '你'}：未订阅\n发送 #远行商人订阅 即可订阅`

    await this.reply(msg)
    return true
  }

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
    const key = `${sub.type}:${sub.id}`
    const max = getMaxSubscriptionsPerTarget()
    if (this.subsCache.has(key) && max <= 1) {
      await this.reply('该目标已订阅过了')
      return true
    }
    this.subsCache.set(key, sub)
    await this.saveSubscriptions()
    await this.reply(`${sub.type === 'group' ? '本群' : '你'}已成功订阅远行商人推送`)
    return true
  }

  async unsubscribeMerchant() {
    const sub = this.buildSubFromEvent()
    if (!sub) {
      await this.reply('无法识别目标')
      return false
    }
    const key = `${sub.type}:${sub.id}`
    if (!this.subsCache.has(key)) {
      await this.reply('未订阅')
      return true
    }
    this.subsCache.delete(key)
    await this.saveSubscriptions()
    await this.reply(`${sub.type === 'group' ? '本群' : '你'}已取消远行商人订阅`)
    return true
  }

  async listSubscriptions() {
    const all = [...this.subsCache.values()]
    let msg = `远行商人订阅列表\n--------------------\n总计：${all.length}\n\n`
    if (!all.length) msg += '暂无订阅'
    else {
      all.forEach((s, i) => {
        msg += `${i + 1}. [${s.type === 'group' ? '群' : '私'}] ${s.id} - ${s.subscribedAt || ''}\n`
      })
    }
    await this.reply(msg)
    return true
  }

  async testPush() {
    if (!this.subsCache.size) {
      await this.reply('暂无订阅者，无法测试推送')
      return false
    }
    await this.reply(`开始推送测试，共 ${this.subsCache.size} 个订阅...`)
    const result = await this.deliverToSubs(await fetchMerchantViewData())
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
    if (!this.subsCache.size) return

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
      const result = await this.deliverToSubs(view)
      if (result.success > 0) await this.markPushedSlot(slot)
    } catch (err) {
      RuntimeUtil.makeLog('error', `定时推送失败: ${err?.message || err}`, LOG_TAG)
    } finally {
      this.pushInFlight = false
    }
  }

  async deliverToSubs(view) {
    const buf = await renderMerchantImage(view)
    const payload = buf ? msgSegment.image(buf) : formatTextFallback(view)
    let success = 0
    let failed = 0

    for (const sub of this.subsCache.values()) {
      try {
        await this.deliver(sub, payload)
        success++
        await RuntimeUtil.sleep(500)
      } catch (err) {
        failed++
        RuntimeUtil.makeLog('error', `推送失败 ${sub.type}(${sub.id}): ${err?.message || err}`, LOG_TAG)
      }
    }
    return { total: this.subsCache.size, success, failed }
  }

  async deliver(sub, msg) {
    // botId=null：底层按群/好友归属选 bot（对齐 lkwg）
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
      group_id: isGroup ? String(e.group_id) : undefined,
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
