import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { PATHS } from './paths.js'
import { getMerchantConfig } from './config.js'
import { createLogger } from './logger.js'

const LOG_TAG = '洛克王国-远行商人'
const ICON_CACHE_DIR = PATHS.ICON_CACHE_DIR
const MAX_REDIRECTS = 5
const logger = createLogger()

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

      // 转换后的 URL host 与原始 pageUrl 一致（仅路径替换），但仍显式校验一次
      if (!this.isAllowedUrl(iconUrl)) {
        logger.warn(`[${LOG_TAG}] 转换后 URL 不在白名单: ${iconUrl}`)
        return null
      }

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
      const timeout = setTimeout(() => {
        req?.destroy?.()
        reject(new Error('下载超时'))
      }, 15000)
      let redirectCount = 0
      let req = null

      const doRequest = (url) => {
        if (redirectCount >= MAX_REDIRECTS) {
          clearTimeout(timeout)
          reject(new Error('重定向次数超限'))
          return
        }

        // 每次跳转（包含初始请求）都校验白名单，防止重定向逃逸到内网/任意域名
        if (!this.isAllowedUrl(url)) {
          clearTimeout(timeout)
          reject(new Error(`域名不在白名单: ${url}`))
          return
        }

        let parsedUrl
        try {
          parsedUrl = new URL(url)
        } catch {
          clearTimeout(timeout)
          reject(new Error(`URL 解析失败: ${url}`))
          return
        }

        const httpModule = parsedUrl.protocol === 'http:' ? http : https
        redirectCount++

        req = httpModule.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://wiki.biligame.com/',
          }
        }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            const redirectUrl = new URL(response.headers.location, url).href
            response.resume()
            doRequest(redirectUrl)
            return
          }
          if (response.statusCode !== 200) {
            clearTimeout(timeout)
            reject(new Error(`HTTP ${response.statusCode}`))
            return
          }

          // 校验 Content-Type 必须为图片，避免 HTML/JSON 错误页被当作图标落地
          const ct = response.headers['content-type'] || ''
          if (!ct.startsWith('image/')) {
            clearTimeout(timeout)
            response.resume()
            reject(new Error(`非图片类型: ${ct}`))
            return
          }

          const chunks = []
          let totalBytes = 0
          const MAX_BYTES = 5 * 1024 * 1024 // 5MB 上限，避免内存爆掉
          response.on('data', (chunk) => {
            totalBytes += chunk.length
            if (totalBytes > MAX_BYTES) {
              clearTimeout(timeout)
              response.destroy()
              reject(new Error('图片数据超过 5MB 上限'))
              return
            }
            chunks.push(chunk)
          })
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
          response.on('error', (err) => {
            clearTimeout(timeout)
            reject(err)
          })
        })

        req.on('error', (err) => {
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

  /**
   * 复制基础资源（bg.jpg / coin.png / yuanxingshangren.png）到 merchant 缓存目录
   * 渲染时通过 resPrefix 引用本地副本，避免模板里写绝对路径
   *
   * 来源目录由配置 merchant.assets.sourceDir 指定；留空则跳过。
   * 目标目录：data/Roco-data/cache/merchant/
   */
  copyBaseAssets() {
    const merchantConfig = getMerchantConfig() || {}
    const sourceDir = merchantConfig.assets?.sourceDir
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      logger.debug(`[${LOG_TAG}] 跳过基础资源复制: 未配置 sourceDir 或目录不存在`)
      return false
    }

    const targetDir = PATHS.MERCHANT_CACHE_DIR
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    const files = ['bg.jpg', 'coin.png', 'yuanxingshangren.png']
    let copied = 0
    for (const name of files) {
      const src = path.join(sourceDir, name)
      const dst = path.join(targetDir, name)
      if (!fs.existsSync(src)) continue
      try {
        // 始终覆盖，确保用户更新资源后下次启动能拉到最新版
        fs.copyFileSync(src, dst)
        copied++
      } catch (e) {
        logger.warn(`[${LOG_TAG}] 复制资源失败 ${name}: ${e.message}`)
      }
    }

    if (copied > 0) {
      logger.mark(`[${LOG_TAG}] 已复制 ${copied} 个基础资源到 ${targetDir}`)
    }
    return copied > 0
  }
}

export default IconManager
