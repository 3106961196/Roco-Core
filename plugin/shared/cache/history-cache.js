import fs from 'fs'
import path from 'path'
import { PATHS, ensureDirs } from '../paths.js'
import { getBeijingTime } from '../time-utils.js'
import { getCacheConfig } from '../config.js'

const LOG_TAG = '洛克王国-远行商人'

/**
 * 历史记录缓存 - 流式追加的商品历史数据
 *
 * 文件位置：data/Roco-data/cache/merchant/history.json
 * 数据结构：{ records: [{ name, price, buyLimit, recordedAt, timestamp }], updatedAt }
 * 用途：状态查询里展示，不参与渲染/推送
 */
class HistoryCache {
  constructor(options = {}) {
    const cacheConfig = getCacheConfig()
    this.maxHistoryRecords = options.maxHistoryRecords || cacheConfig.maxHistoryRecords || 100
    this.cacheDir = options.cacheDir || PATHS.MERCHANT_CACHE_DIR
    this._filePath = path.join(this.cacheDir, 'history.json')
    this._data = null
  }

  _load() {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.records)) {
          this._data = parsed
          return
        }
      }
    } catch (error) {
      logger.error(`[${LOG_TAG}] 加载历史记录失败: ${error.message}`)
    }
    this._data = { records: [], updatedAt: null }
  }

  _save() {
    try {
      ensureDirs()
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true })
      }
      this._data.updatedAt = getBeijingTime().format('YYYY-MM-DD HH:mm:ss')
      fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2), 'utf-8')
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 保存历史记录失败: ${error.message}`)
      return false
    }
  }

  getHistory() {
    this._load()
    return this._data
  }

  appendToHistory(product) {
    return this.batchAppendToHistory([product])
  }

  /**
   * 批量追加历史记录（单次读-改-写，避免多次 I/O）
   */
  batchAppendToHistory(products) {
    if (!products || products.length === 0) return true

    this._load()
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

    return this._save()
  }

  clear() {
    try {
      if (fs.existsSync(this._filePath)) {
        fs.unlinkSync(this._filePath)
      }
      this._data = { records: [], updatedAt: null }
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 清除历史记录失败: ${error.message}`)
      return false
    }
  }

  getStatus() {
    try {
      if (!fs.existsSync(this._filePath)) {
        return { exists: false }
      }
      const data = JSON.parse(fs.readFileSync(this._filePath, 'utf-8'))
      return {
        exists: true,
        recordCount: data.records?.length || 0,
        updatedAt: data.updatedAt || '--',
      }
    } catch (e) {
      return { exists: true, error: e.message }
    }
  }
}

export default HistoryCache
