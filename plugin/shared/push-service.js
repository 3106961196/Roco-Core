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
   * @param {object} [opts]
   * @param {boolean} [opts.isTest=false] - 是否为测试推送；为 true 时不会覆盖 lastPushedRound/Date
   * @returns {Promise<{total: number, success: number, failed: number, details: Array}>}
   */
  async pushToAll(merchantImage, data, opts = {}) {
    const { isTest = false } = opts

    if (this._pushing) {
      logger.debug(`[${LOG_TAG}] 推送进行中，跳过`)
      return { total: 0, success: 0, failed: 0, details: [] }
    }

    if (!isTest && !this.shouldPush(data)) {
      return { total: 0, success: 0, failed: 0, details: [] }
    }

    this._pushing = true
    try {
      return await this._doPush(merchantImage, data, { isTest })
    } finally {
      this._pushing = false
    }
  }

  async _doPush(merchantImage, data, { isTest }) {
    const pushConfig = getPushConfig()
    const maxRetries = pushConfig.maxRetries || 3
    const retryDelay = (pushConfig.retryDelaySeconds || 10) * 1000

    const subscriptions = this.subscriptionManager.getAll()
    if (subscriptions.length === 0) {
      return { total: 0, success: 0, failed: 0, details: [] }
    }

    // 一次性解析 bot 并缓存整个推送批次内复用，不再每个订阅都遍历 Bot.uin
    let bot
    try {
      bot = this._resolveBot()
    } catch (error) {
      logger.error(`[${LOG_TAG}] ${error.message}`)
      return { total: 0, success: 0, failed: 0, details: [] }
    }

    const roundInfo = data?.roundInfo
    const roundLabel = roundInfo
      ? `第${roundInfo.current}轮 ${roundInfo.timeLabel}`
      : '新时段'

    logger.mark(`[${LOG_TAG}] 开始推送 ${roundLabel}，共 ${subscriptions.length} 个订阅${isTest ? '（测试）' : ''}`)

    let success = 0
    let failed = 0
    const details = []

    for (const sub of subscriptions) {
      let sent = false
      let lastError = null
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const msg = this._buildMessage(merchantImage, sub)
          if (!msg) throw new Error('消息构造失败')

          await this._sendToTarget(bot, sub, msg)
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

    // 仅在非测试模式下更新推送状态，避免 #远行商人推送测试 清空去重标志
    if (!isTest) {
      this.lastPushedRound = roundInfo?.current || null
      this.lastPushedDate = getBeijingTime().format('YYYY-MM-DD')
      this.lastPushTime = Date.now()
    }

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
   * 解析一个可用的 Bot 实例（一次性，整个推送批次复用）
   * 框架使用 AgentRuntime，通过 AgentRuntime.uin 和 AgentRuntime.bots 获取实例
   */
  _resolveBot() {
    if (this._cachedBot && (this._cachedBot.sendMsg || this._cachedBot.pickGroup || this._cachedBot.tasker)) {
      return this._cachedBot
    }
    
    // 优先尝试 AgentRuntime（框架标准方式）
    const runtime = globalThis.AgentRuntime
    if (runtime) {
      // 方式1：通过 AgentRuntime.uin 数组获取
      const uinList = runtime.uin
      if (Array.isArray(uinList) && uinList.length > 0) {
        for (const uin of uinList) {
          if (uin === 'stdin') continue
          const b = runtime.bots?.[uin]
          if (b && (b.sendMsg || b.pickGroup || b.pickFriend || b.tasker)) {
            this._cachedBot = b
            return b
          }
        }
      }
      
      // 方式2：直接遍历 AgentRuntime.bots
      if (runtime.bots && typeof runtime.bots === 'object') {
        for (const [uin, b] of Object.entries(runtime.bots)) {
          if (uin === 'stdin' || uin === 'port' || uin === 'apiKey') continue
          if (b && (b.sendMsg || b.pickGroup || b.pickFriend || b.tasker)) {
            this._cachedBot = b
            return b
          }
        }
      }
    }
    
    // 兜底：尝试 Bot（兼容旧版本）
    const botGlobal = globalThis.Bot
    if (botGlobal) {
      const uinList = botGlobal.uin
      if (uinList) {
        for (const id of uinList) {
          if (id === 'stdin') continue
          const b = botGlobal[id]
          if (b && (b.sendMsg || b.pickGroup || b.pickFriend || b.tasker)) {
            this._cachedBot = b
            return b
          }
        }
      }
    }
    
    throw new Error('找不到可用的 Bot 实例，请确认框架已启动')
  }

  /**
   * 向单个目标发送消息
   * 优先走框架的 sendGroupMsg/sendFriendMsg（tasker 优先，能正确路由到对应 bot），
   * 回退到 pickGroup/pickFriend.sendMsg。无返回值校验——sendMsg 返回 undefined 不等于失败。
   */
  async _sendToTarget(bot, subscription, msg) {
    if (subscription.type === 'group') {
      const groupId = Number(subscription.id)

      if (bot.tasker?.sendGroupMsg) {
        const data = { self_id: bot.uin || bot.self_id, bot, group_id: groupId }
        return await bot.tasker.sendGroupMsg(data, msg)
      }

      if (typeof bot.pickGroup === 'function') {
        const group = bot.pickGroup(groupId)
        if (group?.sendMsg) return await group.sendMsg(msg)
      }

      if (typeof bot.sendMsg === 'function') {
        return await bot.sendMsg({ group_id: groupId }, msg)
      }
      throw new Error('当前 Bot 不支持群消息发送')
    }

    if (subscription.type === 'private') {
      const userId = Number(subscription.id)

      if (bot.tasker?.sendFriendMsg) {
        const data = { self_id: bot.uin || bot.self_id, bot, user_id: userId }
        return await bot.tasker.sendFriendMsg(data, msg)
      }

      if (typeof bot.pickFriend === 'function') {
        const friend = bot.pickFriend(userId)
        if (friend?.sendMsg) return await friend.sendMsg(msg)
      }

      if (typeof bot.sendMsg === 'function') {
        return await bot.sendMsg({ user_id: userId }, msg)
      }
      throw new Error('当前 Bot 不支持好友消息发送')
    }

    throw new Error(`未知订阅类型: ${subscription.type}`)
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
