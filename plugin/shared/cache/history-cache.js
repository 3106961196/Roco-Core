import { getBeijingTime } from '../time-utils.js'
import { getCacheConfig } from '../config.js'

const LOG_TAG = '洛克王国-远行商人'

/**
 * 历史记录缓存 - 内存级快速缓存
 *
 * 用途：状态查询里展示最近记录，不参与渲染/推送
 * 持久化存储已迁移至 MongoDB (product-store.js)
 */
class HistoryCache {
  constructor(options = {}) {
    const cacheConfig = getCacheConfig()
    this.maxHistoryRecords = options.maxHistoryRecords || cacheConfig.maxHistoryRecords || 100
    this._data = { records: [], updatedAt: null }
  }

  getHistory() {
    return this._data
  }

  appendToHistory(product) {
    return this.batchAppendToHistory([product])
  }

  /**
   * 批量追加历史记录（内存缓存）
   */
  batchAppendToHistory(products) {
    if (!products || products.length === 0) return true

    const now = getBeijingTime().format('YYYY-MM-DD HH:mm:ss')
    const timestamp = Date.now()

    for (const product of products) {
      this._data.records.push({
        ...product,
        recordedAt: now,
        timestamp,
      })
    }

    if (this._data.records.length > this.maxHistoryRecords) {
      this._data.records = this._data.records.slice(-this.maxHistoryRecords)
    }

    this._data.updatedAt = now
    return true
  }

  clear() {
    this._data = { records: [], updatedAt: null }
    return true
  }

  getStatus() {
    return {
      exists: this._data.records.length > 0,
      recordCount: this._data.records.length,
      updatedAt: this._data.updatedAt || '--',
    }
  }
}

export default HistoryCache
