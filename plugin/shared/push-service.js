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
   * @param {object} merchantImage - 渲染好的图片消息 (segment.image 或 Buffer/路径)
   * @param {object} data - 商人数据
   * @returns {Promise<{total: number, success: number, failed: number, details: Array}>}
   */
  async pushToAll(merchantImage, data) {
    if (this._pushing) {
      logger.debug(`[${LOG_TAG}] 推送进行中，跳过`)
      return { total: 0, success: 0, failed: 0, details: [] }
    }

    if (!this.shouldPush(data)) {
      return { total: 0, success: 0, failed: 0, details: [] }
    }

    this._pushing = true
    const pushConfig = getPushConfig()
    const maxRetries = pushConfig.maxRetries || 3
    const retryDelay = (pushConfig.retryDelaySeconds || 10) * 1000

    const subscriptions = this.subscriptionManager.getAll()
    if (subscriptions.length === 0) {
      this._pushing = false
      return { total: 0, success: 0, failed: 0, details: [] }
    }

    const roundInfo = data?.roundInfo
    const roundLabel = roundInfo
      ? `第${roundInfo.current}轮 ${roundInfo.timeLabel}`
      : '新时段'

    logger.mark(`[${LOG_TAG}] 开始推送 ${roundLabel}，共 ${subscriptions.length} 个订阅`)

    let success = 0
    let failed = 0
    const details = []

    for (const sub of subscriptions) {
      let sent = false
      let lastError = null
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // 构造标准消息格式
          const msg = this._buildMessage(merchantImage, sub)
          if (!msg) throw new Error('消息构造失败')

          const result = await this._sendToTarget(sub, msg)

          // 验证发送结果（XRK-AGT框架sendMsg应返回非空值）
          if (result === undefined || result === false) {
            throw new Error('sendMsg返回空值，可能发送失败')
          }

          sent = true
          success++
          details.push({ type: sub.type, id: sub.id, success: true })
          break
        } catch (error) {
          lastError = error
          if (attempt < maxRetries) {
            logger.debug(`[${LOG_TAG}] 推送失败 ${sub.type}(${sub.id}) 第${attempt}次，${retryDelay / 1000}秒后重试: ${error.message}`)
            await this._sleep(retryDelay)
          } else {
            logger.error(`[${LOG_TAG}] 推送失败 ${sub.type}(${sub.id})，已重试${maxRetries}次: ${error.message}`)
            details.push({ type: sub.type, id: sub.id, success: false, error: error.message })
          }
        }
      }
      if (!sent) failed++

      // 每次推送后短暂间隔，避免QQ风控限流
      await this._sleep(500)
    }

    // 更新推送状态
    this.lastPushedRound = roundInfo?.current || null
    this.lastPushedDate = getBeijingTime().format('YYYY-MM-DD')
    this.lastPushTime = Date.now()
    this._pushing = false

    logger.mark(`[${LOG_TAG}] 推送完成: 成功 ${success}，失败 ${failed}`)

    return { total: subscriptions.length, success, failed, details }
  }

  /**
   * 构造消息对象
   * 支持多种输入格式：segment.image对象、Buffer、文件路径
   */
  _buildMessage(merchantImage, sub) {
    if (!merchantImage) return null

    // 如果已经是标准的segment.image对象，直接返回
    if (typeof merchantImage === 'object' && merchantImage.type === 'image') {
      return [merchantImage]
    }

    // 如果是Buffer或字符串路径，构造image segment
    if (Buffer.isBuffer(merchantImage)) {
      return [{ type: 'image', data: { file: 'base64://' + merchantImage.toString('base64') } }]
    }

    if (typeof merchantImage === 'string') {
      return [{ type: 'image', data: { file: merchantImage } }]
    }

    // 其他情况尝试直接使用
    return [merchantImage]
  }

  /**
   * 向单个目标发送消息
   * 使用 bot.sendMsg 便捷方法（支持 { user_id } 或 { group_id } 参数）
   * @returns {Promise<any>} 发送结果
   */
  async _sendToTarget(subscription, msg) {
    let bot = null
    for (const id of Bot.uin) {
      if (id === 'stdin') continue
      const b = Bot[id]
      if (b && typeof b.sendMsg === 'function') {
        bot = b
        break
      }
    }
    if (!bot) throw new Error('找不到可用的 Bot 实例')

    if (subscription.type === 'group') {
      const result = await bot.sendMsg({ group_id: String(subscription.id) }, msg)
      if (!result) throw new Error(`群 ${subscription.id} 发送失败`)
      return result
    } else if (subscription.type === 'private') {
      const result = await bot.sendMsg({ user_id: String(subscription.id) }, msg)
      if (!result) throw new Error(`好友 ${subscription.id} 发送失败`)
      return result
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
