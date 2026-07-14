import { getBeijingTime, getRoundInfo, shouldDetectNow } from './time-utils.js'
import { backfillYesterday } from './backfill.js'

const LOG_TAG = '洛克王国-远行商人'

/**
 * 调度器 - 负责定时检测、补抓、推送触发
 *
 * 设计：
 * - 单例锁（_singletonInstance）防止插件被多次实例化导致重复执行
 * - 启动时同步当前轮次号，但不触发推送
 * - 轮次变化时重置 roundDataFetched，触发新一轮检测
 * - 0:00-8:00 闭市时段：跑一次 0:00 补抓（每天首次）
 */
class MerchantScheduler {
  /**
   * @param {object} deps
   * @param {object} deps.crawler - MerchantCrawler
   * @param {object} deps.renderer - MerchantRenderer
   * @param {object} deps.subscriptionManager - SubscriptionManager
   * @param {object} deps.pushService - PushService
   */
  constructor({ crawler, renderer, subscriptionManager, pushService }) {
    this.crawler = crawler
    this.renderer = renderer
    this.subscriptionManager = subscriptionManager
    this.pushService = pushService

    this.lastDetectionTime = null
    this.internalTimer = null
    this._initialized = false
  }

  /**
   * 初始化 - 启动定时器
   */
  async init() {
    if (this._initialized) return

    // 启动时同步当前轮次号
    const bootRoundInfo = getRoundInfo()
    this.currentRoundIndex = bootRoundInfo.current
    this.roundDataFetched = false
    this._lastBackfillDate = null

    // 框架重启后：将推送状态同步到当前轮次，防止重启后误推
    if (bootRoundInfo.current > 0) {
      this.pushService.lastPushedRound = bootRoundInfo.current
      this.pushService.lastPushedDate = getBeijingTime().format('YYYY-MM-DD')

    }

    // 绑定检测成功回调
    this.crawler.onDetectionSuccess = (data) => this.onDetectionSuccess(data)

    await this.crawler.init()
    this.startInternalScheduler()
    this._initialized = true
  }

  startInternalScheduler() {
    if (this.internalTimer) {
      clearInterval(this.internalTimer)
    }

    this.internalTimer = setInterval(() => {
      this.scheduleTick().catch(e => {
        logger.error(`[${LOG_TAG}] 调度异常: ${e.message}`)
      })
    }, 60 * 1000)

    // 启动后立即跑一次
    this.scheduleTick().catch(() => {})
  }

  /**
   * 每分钟调度一次的总入口
   * 闭市时段：跑补抓；其他时段：跑检测
   */
  async scheduleTick() {
    const roundInfo = getRoundInfo()

    // 闭市时段：0:00 补抓 + 跳过检测
    if (roundInfo.status === 'closed') {
      await this.maybeBackfillYesterday()
      return
    }

    await this.scheduleDetection()
  }

  /**
   * 0:00-8:00 闭市时段每天首次进入时跑一次补抓
   * 用 _lastBackfillDate 去重，每天只跑一次
   */
  async maybeBackfillYesterday() {
    const now = getBeijingTime()
    const today = now.format('YYYY-MM-DD')

    // 已补抓过：跳过
    if (this._lastBackfillDate === today) return

    // 只在 0:00-8:00 区间内补抓（防御性，正常闭市时段就是这个范围）
    const hour = now.hour()
    if (hour >= 8) return

    this._lastBackfillDate = today

    try {
      const result = await backfillYesterday({ crawler: this.crawler })
      if (result.added > 0) {
        logger.mark(`[${LOG_TAG}] 0:00 补抓完成: 新增 ${result.added} 个时段，累计 ${result.total} 个时段`)
      } else if (result.reason) {
        logger.debug(`[${LOG_TAG}] 0:00 补抓跳过: ${result.reason}`)
      }
    } catch (error) {
      logger.error(`[${LOG_TAG}] 0:00 补抓异常: ${error.message}`)
    }
  }

  /**
   * 定时检测
   *
   * 规则:
   * - 8:00-12:00 第1轮 / 12:00-16:00 第2轮 / 16:00-20:00 第3轮 / 20:00-24:00 第4轮
   * - waiting 状态：跳过（轮次刚开始但还在 delayMinutes 延迟期内）
   * - 轮次变化：重置 roundDataFetched
   * - 本轮已抓取过：跳过
   * - 缓存有效：标记已抓取并跳过
   */
  async scheduleDetection() {
    try {
      const roundInfo = getRoundInfo()

      if (roundInfo.status === 'waiting') return

      // 检测新轮次
      if (roundInfo.current !== this.currentRoundIndex) {
        this.currentRoundIndex = roundInfo.current
        this.roundDataFetched = false
        logger.mark(`[${LOG_TAG}] 第${roundInfo.current}轮 ${roundInfo.timeLabel}`)
      }

      // 已获取过本轮数据或正在检测中：跳过
      if (this.roundDataFetched || this.crawler.isDetecting) return

      // 检查今日缓存是否已有本轮有效数据
      try {
        const cached = await this.crawler.cache.getToday()
        if (cached && this.crawler.cache.isValid(cached) && cached.productCount > 0) {
          this.roundDataFetched = true
          return
        }
      } catch (e) {
        // 缓存读取失败时继续执行检测
      }

      this.lastDetectionTime = Date.now()
      this.crawler.startDetection()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 调度异常: ${error.message}`)
    }
  }

  /**
   * 检测成功后触发推送
   * 流程: 检查图标 → 补全图标 → 渲染图片 → 推送
   */
  async onDetectionSuccess(data) {
    // 闭市时段禁止推送
    const roundInfo = data?.roundInfo
    if (!roundInfo || roundInfo.status === 'closed') return

    if (!this.pushService.isEnabled()) return
    if (!this.pushService.shouldPush(data)) return

    try {
      // 1. 确保所有商品图标已下载
      await this.renderer.ensureIcons(data.products)

      // 2. 渲染图片
      let merchantImage = null
      if (data.productCount > 0) {
        const renderData = this.renderer.prepareRenderData(data)
        merchantImage = await this.renderer.renderImage(renderData)
      }

      // 3. 推送
      await this.pushService.pushToAll(merchantImage, data)
    } catch (error) {
      logger.error(`[${LOG_TAG}] 推送执行异常: ${error.message}`)
    }
  }

  /**
   * 手动触发一次抓取（用于 #强制刷新远行人 命令）
   * 抓取成功后会走正常的 onDetectionSuccess 链路
   */
  async forceRefresh() {
    this.roundDataFetched = false
    await this.crawler.cache.clearAll()
    return await this.crawler.getData(true)
  }

  async destroy() {
    if (this.internalTimer) {
      clearInterval(this.internalTimer)
      this.internalTimer = null
    }
    try {
      await this.crawler.destroy()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 清理失败: ${error.message}`)
    }
  }
}

export default MerchantScheduler
