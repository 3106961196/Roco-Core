import fs from 'fs'
import path from 'path'
import { PATHS } from '../paths.js'
import { getBeijingTime } from '../time-utils.js'
import { getCacheConfig } from '../config.js'

const LOG_TAG = '洛克王国-远行商人'

// 保留最近N天的日期缓存文件
const MAX_CACHE_DAYS = 2

/**
 * 今日缓存 - 按日期存储的「远行商人」商品快照
 *
 * 文件结构：data/Roco-data/cache/merchant/today_YYYY-MM-DD.json
 * 数据内容：{ date, roundInfo, productCount, products, historyGroups, fetchedAt, _cachedAt, ... }
 */
class MerchantCache {
  constructor(options = {}) {
    const cacheConfig = getCacheConfig()
    this.ttl = options.ttl || cacheConfig.ttl || 1800
    this.cacheDir = options.cacheDir || PATHS.MERCHANT_CACHE_DIR

    this.ensureDirs()
    this.cleanOldCacheFiles()
  }

  /**
   * 清理过期的日期缓存文件（只保留最近 MAX_CACHE_DAYS 天）
   */
  cleanOldCacheFiles() {
    try {
      const files = fs.readdirSync(this.cacheDir)
      const today = getBeijingTime().format('YYYY-MM-DD')

      for (const file of files) {
        const match = file.match(/^today_(\d{4}-\d{2}-\d{2})\.json$/)
        if (!match) continue

        const fileDate = match[1]
        const daysDiff = Math.floor(
          (new Date(today) - new Date(fileDate)) / (1000 * 60 * 60 * 24)
        )

        if (daysDiff > MAX_CACHE_DAYS) {
          try {
            fs.unlinkSync(path.join(this.cacheDir, file))
            logger.debug(`[${LOG_TAG}] 清理过期缓存: ${file}`)
          } catch (e) { /* ignore */ }
        }
      }
    } catch (error) {
      logger.debug(`[${LOG_TAG}] 清理缓存文件异常: ${error.message}`)
    }
  }

  ensureDirs() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  get todayCachePath() {
    const today = getBeijingTime().format('YYYY-MM-DD')
    return path.join(this.cacheDir, `today_${today}.json`)
  }

  /**
   * 指定日期的缓存文件路径
   * @param {string} dateStr - YYYY-MM-DD
   */
  cachePathFor(dateStr) {
    return path.join(this.cacheDir, `today_${dateStr}.json`)
  }

  hasValidTodayCache() {
    const cachePath = this.todayCachePath
    if (!fs.existsSync(cachePath)) return false

    try {
      const stats = fs.statSync(cachePath)
      const now = Date.now()
      const age = (now - stats.mtimeMs) / 1000
      return age < this.ttl
    } catch (error) {
      return false
    }
  }

  validateCacheData(data) {
    if (!data || typeof data !== 'object') return false
    if (typeof data._cachedAt !== 'number') return false
    if (typeof data.productCount !== 'number') return false
    if (!Array.isArray(data.products)) return false
    return true
  }

  getToday() {
    try {
      const cachePath = this.todayCachePath
      if (!fs.existsSync(cachePath)) return null

      const raw = fs.readFileSync(cachePath, 'utf-8')
      const data = JSON.parse(raw)

      if (!this.validateCacheData(data)) {
        logger.warn(`[${LOG_TAG}] 今日缓存数据结构异常，已忽略`)
        return null
      }
      if (!this.isValid(data)) return null
      return data
    } catch (error) {
      logger.error(`[${LOG_TAG}] 读取今日缓存失败: ${error.message}`)
      return null
    }
  }

  /**
   * 获取昨日缓存数据（闭市时段 / 第1轮显示使用）
   */
  getYesterday() {
    try {
      const yesterday = getBeijingTime().subtract(1, 'day').format('YYYY-MM-DD')
      const cachePath = this.cachePathFor(yesterday)
      if (!fs.existsSync(cachePath)) return null

      const raw = fs.readFileSync(cachePath, 'utf-8')
      const data = JSON.parse(raw)
      if (!this.validateCacheData(data)) return null
      return data
    } catch (error) {
      logger.error(`[${LOG_TAG}] 读取昨日缓存失败: ${error.message}`)
      return null
    }
  }

  setToday(data) {
    try {
      this.ensureDirs()
      const cacheData = {
        ...JSON.parse(JSON.stringify(data)),
        _cachedAt: Date.now(),
        _expiresAt: Date.now() + (this.ttl * 1000),
        _type: 'today',
      }
      fs.writeFileSync(this.todayCachePath, JSON.stringify(cacheData, null, 2), 'utf-8')
      logger.mark(`[${LOG_TAG}] 缓存 ${data.productCount || 0} 个商品`)
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 写入今日缓存失败: ${error.message}`)
      return false
    }
  }

  /**
   * 写入指定日期的缓存（用于补抓昨日数据，不修改今日）
   * @param {string} dateStr - YYYY-MM-DD
   * @param {object} data - 缓存数据
   */
  setForDate(dateStr, data) {
    try {
      this.ensureDirs()
      const cacheData = {
        ...JSON.parse(JSON.stringify(data)),
        _cachedAt: Date.now(),
        _expiresAt: Date.now() + (this.ttl * 1000),
        _type: 'today',
      }
      fs.writeFileSync(this.cachePathFor(dateStr), JSON.stringify(cacheData, null, 2), 'utf-8')
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 写入缓存 ${dateStr} 失败: ${error.message}`)
      return false
    }
  }

  /**
   * 写入昨日缓存（补抓场景使用，保留原 _cachedAt 以免影响 TTL 判定）
   */
  setYesterday(data) {
    const yesterday = getBeijingTime().subtract(1, 'day').format('YYYY-MM-DD')
    // 若已有昨日缓存则合并 _cachedAt，避免补抓后立即失效
    const existing = this.getYesterday()
    const merged = {
      ...data,
      _cachedAt: existing?._cachedAt || Date.now(),
      _expiresAt: existing?._expiresAt || (Date.now() + this.ttl * 1000),
      _type: 'today',
    }
    return this.setForDate(yesterday, merged)
  }

  clearToday() {
    try {
      const cachePath = this.todayCachePath
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath)
        logger.mark(`[${LOG_TAG}] 今日缓存已清除`)
      }
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 清除今日缓存失败: ${error.message}`)
      return false
    }
  }

  clearAll() {
    this.clearToday()
    try {
      const files = fs.readdirSync(this.cacheDir)
      for (const file of files) {
        if (file.match(/^today_.*\.json$/)) {
          try { fs.unlinkSync(path.join(this.cacheDir, file)) } catch (e) { /* ignore */ }
        }
      }
      logger.mark(`[${LOG_TAG}] 所有今日缓存已清除`)
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 清除所有缓存失败: ${error.message}`)
      return false
    }
  }

  isValid(data) {
    if (!data || !data._cachedAt) return false
    const now = Date.now()
    const age = (now - data._cachedAt) / 1000
    return age < this.ttl
  }

  getStatus() {
    const todayExists = fs.existsSync(this.todayCachePath)

    let todayInfo = null
    if (todayExists) {
      try {
        const data = JSON.parse(fs.readFileSync(this.todayCachePath, 'utf-8'))
        todayInfo = {
          exists: true,
          valid: this.isValid(data),
          productCount: data.productCount || 0,
          cachedAt: data._cachedAt ? new Date(data._cachedAt).toLocaleString() : '--',
          age: data._cachedAt ? Math.floor((Date.now() - data._cachedAt) / 1000) + '秒' : '--',
        }
      } catch (e) {
        todayInfo = { exists: true, valid: false, error: e.message }
      }
    }

    return { today: todayInfo || { exists: false } }
  }
}

export default MerchantCache
