import fs from 'node:fs/promises'
import path from 'path'
import RendererLoader from '../../../../src/infrastructure/renderer/loader.js'
import { PATHS } from './paths.js'
import { getBeijingTime, getRoundInfo } from './time-utils.js'
import { getUIConfig } from './config.js'

const LOG_TAG = '洛克王国-远行商人'

// 模板目录: core/Roco-Core/resources/远行商人/
const TPL_DIR = path.join(PATHS.BASE_DIR, 'resources', '远行商人')
const TPL_FILE = path.join(TPL_DIR, 'merchant.html')

/**
 * 将绝对路径转为 file:/// URL（Windows 兼容）
 */
function toFileUrl(absPath) {
  const p = String(absPath).replace(/\\/g, '/')
  return (p.startsWith('/') ? 'file://' : 'file:///') + p
}

/**
 * 获取商品图标本地路径（用于渲染）
 */
function getIconUrl(iconManager, name) {
  if (iconManager.hasIcon(name)) {
    const localPath = iconManager.getLocalIconPath(name).replace(/\\/g, '/')
    return `file:///${localPath}`
  }
  return ''
}

/**
 * 渲染器 - 准备渲染数据并产出图片
 *
 * 依赖：
 * - crawler.iconManager（用于本地图标路径解析）
 * - crawler.cache（用于加载昨日历史）
 * - getRoundInfo / getBeijingTime（实时时间，避免使用冻结的倒计时）
 */
class MerchantRenderer {
  /**
   * @param {object} deps
   * @param {object} deps.crawler - MerchantCrawler 实例
   */
  constructor({ crawler }) {
    this.crawler = crawler
  }

  /**
   * 准备渲染数据 - 根据当前轮次决定历史商品显示范围
   *
   * 显示规则:
   * - 第1轮: 本轮新商品 + 昨日四次推送的已过期商品
   * - 第2轮: 本轮新商品 + 今日已过期的第1轮商品
   * - 第3轮: 本轮新商品 + 今日已过期的第1、2轮商品
   * - 第4轮: 本轮新商品 + 今日已过期的第1、2、3轮商品
   */
  prepareRenderData(data) {
    const resPrefix = toFileUrl(TPL_DIR) + '/'
    const uiConfig = getUIConfig()
    const liveRoundInfo = getRoundInfo()
    const currentRound = liveRoundInfo.current || 1

    const currentProducts = (data.products || []).map(p => {
      const priceNum = this.crawler.parsePrice(p.price)
      const limitNum = parseInt(p.buyLimit || p.limit) || 0
      const totalCost = priceNum * limitNum
      return {
        name: p.name,
        iconUrl: getIconUrl(this.crawler.iconManager, p.name),
        price: p.price || '未知',
        priceDisplay: priceNum > 0 ? priceNum.toLocaleString() : p.price || '未知',
        limit: p.buyLimit || p.limit || '-',
        totalCost,
        totalCostDisplay: totalCost > 0 ? totalCost.toLocaleString() : '-',
      }
    })

    const currentProductNames = new Set(currentProducts.map(p => p.name))

    // 已结束时段中，排除同时出现在当前轮次的商品（避免重复显示）
    const todayEnded = (data.historyGroups || [])
      .filter(g => g.statusLabel === '已结束')
      .map(g => ({
        time: g.timeLabel || '--:--',
        status: 'ended',
        products: (g.products || [])
          .filter(p => !currentProductNames.has(p.name))
          .map(p => ({
            name: p.name,
            iconUrl: getIconUrl(this.crawler.iconManager, p.name),
          })),
      }))
      .filter(g => g.products.length > 0)

    // 第1轮需要额外显示昨日的全部已过期商品
    let yesterdayEnded = []
    if (currentRound === 1) {
      yesterdayEnded = this._loadYesterdayHistory()
    }

    const otherPeriods = [...yesterdayEnded, ...todayEnded]

    return {
      saveId: `merchant_${Date.now()}`,
      tplFile: TPL_FILE,
      imgType: uiConfig.format || 'jpeg',
      quality: uiConfig.imageQuality || 90,
      sys: { scale: 3 },
      resPrefix,

      date: data.date || getBeijingTime().format('YYYY-MM-DD'),
      currentRound,
      totalRounds: liveRoundInfo.total || 4,
      remainingTime: liveRoundInfo.countdown || '--',
      nextRoundTime: '',
      isClosed: false,

      currentProducts,
      otherPeriods,
    }
  }

  /**
   * 闭市时段(0:00-8:00)的渲染数据：显示昨日全天四次推送的已过期商品
   */
  prepareClosedData(roundInfo) {
    const resPrefix = toFileUrl(TPL_DIR) + '/'
    const uiConfig = getUIConfig()
    const liveRoundInfo = getRoundInfo()

    const otherPeriods = this._loadYesterdayHistory()

    return {
      saveId: `merchant_closed_${Date.now()}`,
      tplFile: TPL_FILE,
      imgType: uiConfig.format || 'jpeg',
      quality: uiConfig.imageQuality || 90,
      sys: { scale: 3 },
      resPrefix,

      date: getBeijingTime().format('YYYY-MM-DD'),
      currentRound: 0,
      totalRounds: liveRoundInfo.total,
      remainingTime: '',
      nextRoundTime: liveRoundInfo.countdown,
      isClosed: true,

      currentProducts: [],
      otherPeriods,
    }
  }

  /**
   * 加载昨日历史商品数据（用于闭市时段和第1轮显示）
   * 兼容 JSON 文件不存在或仅包含部分轮次数据的情况
   */
  _loadYesterdayHistory() {
    try {
      const yesterdayData = this.crawler.cache.getYesterday()
      if (!yesterdayData) return []

      const groups = []

      // 优先从 historyGroups 提取（包含完整时段信息）
      if (yesterdayData.historyGroups && yesterdayData.historyGroups.length > 0) {
        for (const g of yesterdayData.historyGroups) {
          groups.push({
            time: `昨日 ${g.timeLabel || '--:--'}`,
            status: 'ended',
            products: (g.products || []).map(p => ({
              name: p.name,
              iconUrl: getIconUrl(this.crawler.iconManager, p.name),
            })),
          })
        }
        return groups
      }

      // 回退: 从 products 列表构建（仅有一轮数据的情况）
      if (yesterdayData.products && yesterdayData.products.length > 0) {
        const timeLabel = yesterdayData.roundInfo?.timeLabel || '昨日'
        groups.push({
          time: `昨日 ${timeLabel}`,
          status: 'ended',
          products: yesterdayData.products.map(p => ({
            name: p.name,
            iconUrl: getIconUrl(this.crawler.iconManager, p.name),
          })),
        })
      }

      return groups
    } catch (error) {
      logger.debug(`[${LOG_TAG}] 加载昨日历史失败: ${error.message}`)
      return []
    }
  }

  /**
   * 使用框架渲染器直接渲染图片
   */
  async renderImage(renderData) {
    try {
      await RendererLoader.ensureLoaded()
      const renderer = RendererLoader.getRenderer()
      if (!renderer) {
        logger.error(`[${LOG_TAG}] 渲染器不可用`)
        return false
      }
      const img = await renderer.render('远行商人', renderData)
      if (!img) return false

      // 渲染完成后删除临时 HTML 文件
      if (renderData.saveId) {
        const htmlPath = `./trash/html/远行商人/${renderData.saveId}.html`
        fs.unlink(htmlPath).catch(() => {})
      }
      return img
    } catch (error) {
      logger.error(`[${LOG_TAG}] 渲染图片失败: ${error.message}`)
      return false
    }
  }

  /**
   * 确保商品图标已下载到本地（在渲染和推送前调用）
   */
  async ensureIcons(products) {
    if (!products || products.length === 0) return
    const needDownload = products.filter(p =>
      p.name && !this.crawler.iconManager.hasIcon(p.name) && p.icon
    )
    if (needDownload.length > 0) {
      logger.debug(`[${LOG_TAG}] 补全图标: ${needDownload.length} 个缺失`)
      await this.crawler.iconManager.batchDownloadIcons(needDownload, 3)
    }
  }
}

export { toFileUrl, getIconUrl }
export default MerchantRenderer
