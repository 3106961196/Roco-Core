import { getPushConfig } from './config.js'
import { getBeijingTime } from './time-utils.js'

const LOG_TAG = '洛克王国-远行商人'

/**
 * 推送服务 - 在新时段数据获取后向已订阅用户发送通知
 *
 * 推送策略:
 * - 新轮次数据检测成功后触发推送
 * - 同一轮次内不重复推送（通过 lastPushedRound 追踪）
 * - 闭市时段(0:00-8:00)禁止推送
 * - 推送失败自动重试（可配置重试次数和间隔）
 * - 图片和文字分条发送，确保图片可靠送达
 */
class PushService {
  /**
   * @param {import('./subscription-manager.js').default} subscriptionManager - 订阅管理器实例
   */
  constructor(subscriptionManager) {
    this.subscriptionManager = subscriptionManager
    this.lastPushedRound = null
    this.lastPushedDate = null
    this.lastPushTime = 0
    this._pushing = false
  }

  isEnabled() {
    const pushConfig = getPushConfig()
    return pushConfig.enabled !== false
  }

  /**
   * 判断是否需要推送
   * - 闭市时段不推送
   * - 同一天同一轮次不重复推送
   * - 冷却时间内不推送
   */
  shouldPush(data) {
    if (!this.isEnabled()) return false

    // 闭市时段禁止推送
    const roundInfo = data?.roundInfo
    if (!roundInfo || roundInfo.status === 'closed') return false

    const now = getBeijingTime()
    const currentDate = now.format('YYYY-MM-DD')
    const currentRound = roundInfo.current

    // 同一天同一轮次不重复推送
    if (this.lastPushedDate === currentDate && this.lastPushedRound === currentRound) {
      return false
    }

    // 推送冷却检查
    const pushConfig = getPushConfig()
    const cooldown = (pushConfig.cooldownSeconds || 300) * 1000
    if (Date.now() - this.lastPushTime < cooldown) {
      return false
    }

    return true
  }

  /**
   * 执行推送 - 向所有订阅者发送新时段通知
   * 图片和文字分条发送，确保图片可靠送达
   *
   * @param {object} merchantImage - 渲染好的图片消息 (segment.image)
   * @param {object} data - 商人数据
   * @returns {Promise<{total: number, success: number, failed: number}>}
   */
  async pushToAll(merchantImage, data) {
    if (this._pushing) {
      logger.debug(`[${LOG_TAG}] 推送进行中，跳过`)
      return { total: 0, success: 0, failed: 0 }
    }

    if (!this.shouldPush(data)) {
      return { total: 0, success: 0, failed: 0 }
    }

    this._pushing = true
    const pushConfig = getPushConfig()
    const maxRetries = pushConfig.maxRetries || 3
    const retryDelay = (pushConfig.retryDelaySeconds || 10) * 1000

    const subscriptions = this.subscriptionManager.getAll()
    if (subscriptions.length === 0) {
      this._pushing = false
      return { total: 0, success: 0, failed: 0 }
    }

    const roundInfo = data?.roundInfo
    const roundLabel = roundInfo
      ? `第${roundInfo.current}轮 ${roundInfo.timeLabel}`
      : '新时段'

    logger.mark(`[${LOG_TAG}] 开始推送 ${roundLabel}，共 ${subscriptions.length} 个订阅`)

    let success = 0
    let failed = 0

    for (const sub of subscriptions) {
      let sent = false
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // 只发送图片，不发送文字
          if (merchantImage) {
            await this._sendToTarget(sub, merchantImage)
          }
          sent = true
          success++
          break
        } catch (error) {
          if (attempt < maxRetries) {
            logger.debug(`[${LOG_TAG}] 推送失败 ${sub.type}(${sub.id}) 第${attempt}次，${retryDelay / 1000}秒后重试: ${error.message}`)
            await this._sleep(retryDelay)
          } else {
            logger.error(`[${LOG_TAG}] 推送失败 ${sub.type}(${sub.id})，已重试${maxRetries}次: ${error.message}`)
          }
        }
      }
      if (!sent) failed++
    }

    // 更新推送状态
    this.lastPushedRound = roundInfo?.current || null
    this.lastPushedDate = getBeijingTime().format('YYYY-MM-DD')
    this.lastPushTime = Date.now()
    this._pushing = false

    logger.mark(`[${LOG_TAG}] 推送完成: 成功 ${success}，失败 ${failed}`)

    return { total: subscriptions.length, success, failed }
  }

  /**
   * 向单个目标发送消息
   * 使用 Bot.pickGroup/pickFriend 的 sendMsg 方法，与 reply 走相同链路
   */
  async _sendToTarget(subscription, msg) {
    if (typeof Bot === 'undefined' || !Bot.uin || Bot.uin.length === 0) {
      throw new Error('Bot 未就绪')
    }

    if (subscription.type === 'group') {
      const group = Bot.pickGroup(String(subscription.id))
      if (!group) throw new Error(`群 ${subscription.id} 不存在`)
      await group.sendMsg(msg)
    } else if (subscription.type === 'private') {
      const friend = Bot.pickFriend(String(subscription.id))
      if (!friend) throw new Error(`好友 ${subscription.id} 不存在`)
      await friend.sendMsg(msg)
    } else {
      throw new Error(`未知订阅类型: ${subscription.type}`)
    }
  }

  getStatus() {
    return {
      enabled: this.isEnabled(),
      lastPushedRound: this.lastPushedRound,
      lastPushedDate: this.lastPushedDate,
      lastPushTime: this.lastPushTime ? new Date(this.lastPushTime).toLocaleString() : null,
      isPushing: this._pushing,
      subscriptionStats: this.subscriptionManager.getStats(),
    }
  }

  resetPushState() {
    this.lastPushedRound = null
    this.lastPushedDate = null
    this.lastPushTime = 0
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export default PushService
