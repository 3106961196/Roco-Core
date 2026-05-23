import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { PATHS } from './paths.js'

const LOG_TAG = '洛克王国-远行商人'
const ICON_CACHE_DIR = PATHS.ICON_CACHE_DIR
const MAX_REDIRECTS = 5

// 允许下载图标的域名白名单
const ALLOWED_ICON_DOMAINS = [
  'patchwiki.biligame.com',
  'img.71acg.net',
  'wiki.biligame.com',
  'upload-bbs.mihoyo.com',
]

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

class IconManager {
  constructor() {
    this.downloading = new Map()
    this.ensureDirs()
  }

  ensureDirs() {
    if (!fs.existsSync(ICON_CACHE_DIR)) {
      fs.mkdirSync(ICON_CACHE_DIR, { recursive: true })
    }
  }

  sanitizeFileName(name) {
    let sanitized = (name || 'unknown')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/\.\./g, '_')
      .replace(/\.+/g, '.')
      .substring(0, 50)
      .trim() || 'unknown'

    const baseName = sanitized.split('.')[0].toUpperCase()
    if (WINDOWS_RESERVED_NAMES.has(baseName)) {
      sanitized = `icon_${sanitized}`
    }

    return sanitized
  }

  getLocalIconPath(itemName) {
    const safeName = this.sanitizeFileName(itemName)
    return path.join(ICON_CACHE_DIR, `${safeName}.png`)
  }

  hasIcon(itemName) {
    return fs.existsSync(this.getLocalIconPath(itemName))
  }

  isAllowedUrl(url) {
    try {
      const parsed = new URL(url)
      return ALLOWED_ICON_DOMAINS.some(domain => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain))
    } catch {
      return false
    }
  }

  /**
   * 按需下载图标：本地缓存 → 页面URL下载
   * @param {string} itemName - 物品名称
   * @param {string} pageUrl - 从爬虫页面获取的图标URL
   */
  async downloadIcon(itemName, pageUrl = '') {
    if (!itemName || !itemName.trim()) return null

    // 1. 本地已有则直接返回
    if (this.hasIcon(itemName)) {
      return this.getLocalIconPath(itemName)
    }

    // 2. 没有URL则无法下载
    if (!pageUrl || !this.isAllowedUrl(pageUrl)) {
      logger.warn(`[${LOG_TAG}] 无可用图标URL: ${itemName}`)
      return null
    }

    // 防止并发重复下载
    if (this.downloading.has(itemName)) {
      return this.downloading.get(itemName)
    }

    const downloadPromise = this._doDownload(itemName, pageUrl)
    this.downloading.set(itemName, downloadPromise)

    try {
      return await downloadPromise
    } finally {
      this.downloading.delete(itemName)
    }
  }

  async _doDownload(itemName, pageUrl) {
    try {
      // 缩略图URL转原图URL
      const iconUrl = pageUrl.replace(/\/thumb\//, '/').replace(/\/\d+px-[^/]+$/, '')

      const outputPath = this.getLocalIconPath(itemName)
      await this._downloadImage(iconUrl, outputPath)
      logger.debug(`[${LOG_TAG}] 图标下载成功: ${itemName}`)
      return outputPath
    } catch (error) {
      logger.error(`[${LOG_TAG}] 下载失败 [${itemName}]: ${error.message}`)
      return null
    }
  }

  _downloadImage(imageUrl, outputPath) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('下载超时')), 15000)
      let redirectCount = 0

      const doRequest = (url) => {
        if (redirectCount >= MAX_REDIRECTS) {
          clearTimeout(timeout)
          reject(new Error('重定向次数超限'))
          return
        }

        const parsedUrl = new URL(url)
        const httpModule = parsedUrl.protocol === 'http:' ? http : https
        redirectCount++

        httpModule.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://wiki.biligame.com/',
          }
        }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            const redirectUrl = new URL(response.headers.location, url).href
            doRequest(redirectUrl)
            return
          }
          if (response.statusCode !== 200) {
            clearTimeout(timeout)
            reject(new Error(`HTTP ${response.statusCode}`))
            return
          }

          const chunks = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => {
            clearTimeout(timeout)
            const buffer = Buffer.concat(chunks)
            if (buffer.length < 100) {
              reject(new Error('图片数据过小，可能不是有效图标'))
              return
            }
            fs.writeFileSync(outputPath, buffer)
            resolve(outputPath)
          })
        }).on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
      }

      doRequest(imageUrl)
    })
  }

  /**
   * 批量按需下载图标（仅下载本地没有的）
   */
  async batchDownloadIcons(items, maxConcurrent = 3) {
    const results = new Map()
    const queue = [...items]

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (item && item.name) {
          const result = await this.downloadIcon(item.name, item.icon || '')
          results.set(item.name, result)
        }
      }
    }

    const workers = Array(Math.min(maxConcurrent, items.length))
      .fill(null)
      .map(() => worker())

    await Promise.all(workers)

    const hitCount = [...results.values()].filter(v => v !== null).length
    logger.debug(`[${LOG_TAG}] 图标补全: ${hitCount}/${items.length} 个`)
    return results
  }

  copyBaseAssets() {
    return true
  }
}

export default IconManager
