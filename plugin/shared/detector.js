import { shouldDetectNow } from './time-utils.js'
import { getDetectionConfig } from './config.js'

const LOG_TAG = '洛克王国-远行商人'

/**
 * 检测器 - 负责定时检测商品数据更新
 *
 * 职责：
 * - 在轮次开放时段内定时检测商品数据
 * - 检测成功后触发回调通知外部
 * - 管理检测状态和重试逻辑
 */
class Detector {
  /**
   * @param {object} deps
   * @param {Function} deps.fetchData - 获取数据的函数 (forceRefresh: boolean) => Promise<data>
   */
  constructor({ fetchData }) {
    const detectionConfig = getDetectionConfig()

    this.fetchData = fetchData
    this.detectionInterval = (detectionConfig.intervalSeconds || 60) * 1000
    this.maxRetries = detectionConfig.maxRetries || 30

    this.isDetecting = false
    this.detectionTimer = null
    this.retryCount = 0
    this.onDetectionSuccess = null
  }

  /**
   * 启动检测轮询
   */
  start() {
    if (this.isDetecting) return

    this.isDetecting = true
    this.retryCount = 0
    this._detect()
  }

  /**
   * 停止检测轮询
   */
  stop() {
    this.isDetecting = false

    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer)
      this.detectionTimer = null
    }
  }

  /**
   * 内部检测方法
   */
  async _detect() {
    if (!shouldDetectNow()) {
      this.stop()
      return
    }

    this.retryCount++

    try {
      const data = await this.fetchData(true)

      // 检测成功条件：有在当前轮次到期的商品
      // 多轮次商品可能跨多天，只有 expireTimestamp 对应当前轮次的才算本轮新商品
      const hasCurrentRoundProducts = data.currentRoundExpiringCount > 0
      if (data.success && data.productCount > 0 && hasCurrentRoundProducts) {
        logger.mark(`[${LOG_TAG}] 检测成功 ${data.productCount} 个商品（本轮到期${data.currentRoundExpiringCount}个）`)
        this.stop()
        // 通知外部检测成功
        if (typeof this.onDetectionSuccess === 'function') {
          await this.onDetectionSuccess(data)
        }
        return
      }

      // 有商品但没有本轮到期的，不算真正的新轮次数据
      if (data.success && data.productCount > 0 && !hasCurrentRoundProducts) {
        logger.debug(`[${LOG_TAG}] 检测到${data.productCount}个商品但无本轮到期商品，继续等待`)
      }

      if (this.retryCount >= this.maxRetries) {
        logger.warn(`[${LOG_TAG}] 检测达到最大重试次数 (${this.maxRetries})`)
        this.stop()
        return
      }

      this.detectionTimer = setTimeout(() => this._detect(), this.detectionInterval)
    } catch (error) {
      logger.error(`[${LOG_TAG}] 检测异常: ${error.message}`)

      if (this.retryCount < this.maxRetries) {
        this.detectionTimer = setTimeout(() => this._detect(), this.detectionInterval)
      } else {
        this.stop()
      }
    }
  }

  /**
   * 销毁检测器
   */
  destroy() {
    this.stop()
    this.onDetectionSuccess = null
  }
}

export default Detector
