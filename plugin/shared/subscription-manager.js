import fs from 'fs'
import path from 'path'
import moment from 'moment-timezone'
import { PATHS, ensureDirs } from './paths.js'
import { getBeijingTime } from './time-utils.js'
import { getSubscriptionConfig } from './config.js'

const TIMEZONE = 'Asia/Shanghai'

const LOG_TAG = '洛克王国-远行商人'

/**
 * 订阅管理器 - 管理远行商人推送订阅
 *
 * 数据存储: data/subscription/subscriptions.json
 * 结构: { subscriptions: [{ type, id, subscribedAt, subscribedBy, group_id? }], updatedAt }
 */
class SubscriptionManager {
  constructor() {
    ensureDirs()
    this._filePath = path.join(PATHS.SUBSCRIPTION_DIR, 'subscriptions.json')
    this._data = null
    this._load()
  }

  /** 加载订阅数据 */
  _load() {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.subscriptions)) {
          this._data = parsed
          return
        }
      }
    } catch (error) {
      logger.error(`[${LOG_TAG}] 加载订阅数据失败: ${error.message}`)
    }
    this._data = { subscriptions: [], updatedAt: null }
  }

  /** 持久化订阅数据 */
  _save() {
    try {
      ensureDirs()
      this._data.updatedAt = getBeijingTime().format('YYYY-MM-DD HH:mm:ss')
      fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2), 'utf-8')
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 保存订阅数据失败: ${error.message}`)
      return false
    }
  }

  /**
   * 生成订阅唯一键
   * @param {string} type - 'group' | 'private'
   * @param {string} id - 群号或用户ID
   */
  _makeKey(type, id) {
    return `${type}:${id}`
  }

  /**
   * 添加订阅
   *
   * 上限语义：maxSubscriptionsPerTarget 表示「每个 (type,id) 最多允许的订阅记录数」。
   * 当上限 >= 1 时按 (type,id) 维度去重；上限 > 1 时允许同一目标被多个用户分别订阅，
   * 用于"不同管理员分别为同一个群订阅"的场景。
   *
   * @param {object} info - { type, id, subscribedBy, group_id? }
   * @returns {{ ok: boolean, msg: string }}
   */
  subscribe(info) {
    const { type, id, subscribedBy } = info

    if (!type || !id) {
      return { ok: false, msg: '参数不完整' }
    }

    if (!['group', 'private'].includes(type)) {
      return { ok: false, msg: '无效的订阅类型' }
    }

    const subConfig = getSubscriptionConfig()
    const maxPerTarget = subConfig.maxSubscriptionsPerTarget || 1

    const sameTargetCount = this._data.subscriptions.filter(
      s => s.type === type && String(s.id) === String(id)
    ).length
    if (sameTargetCount >= maxPerTarget) {
      if (maxPerTarget === 1) {
        return { ok: false, msg: '该目标已订阅过了' }
      }
      return { ok: false, msg: `该目标已达到订阅上限(${maxPerTarget})` }
    }

    this._data.subscriptions.push({
      type,
      id: String(id),
      subscribedAt: getBeijingTime().format('YYYY-MM-DD HH:mm:ss'),
      subscribedBy: String(subscribedBy || 'unknown'),
      group_id: info.group_id ? String(info.group_id) : undefined,
    })

    this._save()
    logger.mark(`[${LOG_TAG}] 新增订阅: ${type}(${id}) by ${subscribedBy}`)

    return { ok: true, msg: '订阅成功' }
  }

  /**
   * 取消订阅
   * @param {string} type - 'group' | 'private'
   * @param {string} id - 群号或用户ID
   * @returns {{ ok: boolean, msg: string }}
   */
  unsubscribe(type, id) {
    const key = this._makeKey(type, id)
    const idx = this._data.subscriptions.findIndex(s => this._makeKey(s.type, s.id) === key)

    if (idx === -1) {
      return { ok: false, msg: '未找到订阅记录' }
    }

    this._data.subscriptions.splice(idx, 1)
    this._save()
    logger.mark(`[${LOG_TAG}] 取消订阅: ${type}(${id})`)

    return { ok: true, msg: '已取消订阅' }
  }

  /**
   * 查询订阅状态
   * @param {string} type - 'group' | 'private'
   * @param {string} id - 群号或用户ID
   * @returns {object|null} 订阅信息或null
   */
  getSubscription(type, id) {
    const key = this._makeKey(type, id)
    return this._data.subscriptions.find(s => this._makeKey(s.type, s.id) === key) || null
  }

  /**
   * 是否已订阅
   */
  isSubscribed(type, id) {
    return this.getSubscription(type, id) !== null
  }

  /**
   * 获取所有订阅
   * @returns {Array}
   */
  getAll() {
    return this._data.subscriptions || []
  }

  /**
   * 获取群组订阅列表
   */
  getGroupSubscriptions() {
    return this._data.subscriptions.filter(s => s.type === 'group')
  }

  /**
   * 获取私聊订阅列表
   */
  getPrivateSubscriptions() {
    return this._data.subscriptions.filter(s => s.type === 'private')
  }

  /**
   * 获取订阅统计
   */
  getStats() {
    const subs = this._data.subscriptions
    return {
      total: subs.length,
      groups: subs.filter(s => s.type === 'group').length,
      private: subs.filter(s => s.type === 'private').length,
      updatedAt: this._data.updatedAt,
    }
  }

  /**
   * 清理过期订阅（超过 autoCleanupDays 天且对应目标不可达的订阅）
   * 此方法为手动触发，不会自动执行
   */
  cleanup() {
    const subConfig = getSubscriptionConfig()
    const days = subConfig.autoCleanupDays || 30
    const cutoff = getBeijingTime().subtract(days, 'days')

    const before = this._data.subscriptions.length
    this._data.subscriptions = this._data.subscriptions.filter(s => {
      const subTime = moment.tz(s.subscribedAt, 'YYYY-MM-DD HH:mm:ss', TIMEZONE)
      return subTime.isValid() && !subTime.isBefore(cutoff)
    })

    const removed = before - this._data.subscriptions.length
    if (removed > 0) {
      this._save()
      logger.mark(`[${LOG_TAG}] 清理过期订阅: ${removed}条`)
    }

    return removed
  }
}

export default SubscriptionManager
