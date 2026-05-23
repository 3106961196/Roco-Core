import MerchantCrawler from './shared/crawler.js'
import PushService from './shared/push-service.js'
import SubscriptionManager from './shared/subscription-manager.js'
import { getBeijingTime, getRoundInfo } from './shared/time-utils.js'
import { PATHS } from './shared/paths.js'
import { getUIConfig, getPushConfig } from './shared/config.js'
import RendererLoader from '../../../src/infrastructure/renderer/loader.js'
import path from 'path'

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

export class RocoMerchant extends plugin {
  constructor() {
    super({
      name: '洛克王国-远行商人',
      dsc: '远行商人商品查询与智能推送',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#远行商人$|^#商人$|^#远行商$',
          fnc: 'queryMerchant',
          log: true
        },
        {
          reg: '^#商人状态$|^#商人检测$',
          fnc: 'showStatus',
          log: true
        },
        {
          reg: '^#刷新商人$|^#强制刷新.*商人',
          fnc: 'forceRefresh',
          permission: 'master',
          log: true
        },
        {
          reg: '^#远行商人订阅$|^#商人订阅$',
          fnc: 'subscribeMerchant',
          permission: 'master',
          log: true
        },
        {
          reg: '^#远行商人取消订阅$|^#取消商人订阅$|^#取消远行商人订阅$',
          fnc: 'unsubscribeMerchant',
          permission: 'master',
          log: true
        },
        {
          reg: '^#远行商人订阅状态$|^#商人订阅状态$',
          fnc: 'showSubscriptionStatus',
          permission: 'master',
          log: true
        },
        {
          reg: '^#远行商人订阅列表$|^#商人订阅列表$',
          fnc: 'listSubscriptions',
          permission: 'master',
          log: true
        },
        {
          reg: '^#远行商人推送测试$|^#商人推送测试$',
          fnc: 'testPush',
          permission: 'master',
          log: true
        }
      ]
    })
  }

  async ensureReady() {
    if (this._initPromise) return this._initPromise
    this._initPromise = this._doInit()
    return this._initPromise
  }

  async _doInit() {
    this.crawler = new MerchantCrawler()
    this.subscriptionManager = new SubscriptionManager()
    this.pushService = new PushService(this.subscriptionManager)
    this.lastDetectionTime = null
    this.currentRoundIndex = -1
    this.roundDataFetched = false
    this.internalTimer = null

    // 绑定检测成功回调，触发推送
    this.crawler.onDetectionSuccess = (data) => this.onDetectionSuccess(data)

    await this.crawler.init()
    this.startInternalScheduler()
  }

  async init() {
    await this.ensureReady()
  }

  startInternalScheduler() {
    if (this.internalTimer) {
      clearInterval(this.internalTimer)
    }

    this.internalTimer = setInterval(() => {
      this.scheduleDetection().catch(e => {
        logger.error(`[${LOG_TAG}] 调度异常: ${e.message}`)
      })
    }, 60 * 1000)

    this.scheduleDetection().catch(() => {})
  }

  // ========== 渲染数据准备 ==========

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
    const currentRound = data.roundInfo?.current || 1

    // 当前轮次商品
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

    // 历史商品: 从今日爬取数据中的已结束时段获取
    const todayEnded = (data.historyGroups || [])
      .filter(g => g.statusLabel === '已结束')
      .map(g => ({
        time: g.timeLabel || '--:--',
        status: 'ended',
        products: (g.products || []).map(p => ({
          name: p.name,
          iconUrl: getIconUrl(this.crawler.iconManager, p.name),
        })),
      }))

    // 第1轮需要额外显示昨日的全部已过期商品
    let yesterdayEnded = []
    if (currentRound === 1) {
      yesterdayEnded = this._loadYesterdayHistory()
    }

    // 合并: 昨日历史在前，今日已结束在后
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
      totalRounds: data.roundInfo?.total || 4,
      remainingTime: data.roundInfo?.countdown || '--',
      nextRoundTime: '',
      isClosed: false,

      currentProducts,
      otherPeriods,
    }
  }

  /**
   * 闭市时段(0:00-8:00)的渲染数据：显示昨日全天四次推送的已过期商品
   * 兼容JSON文件不存在或仅包含部分数据的情况
   */
  prepareClosedData(roundInfo) {
    const resPrefix = toFileUrl(TPL_DIR) + '/'
    const uiConfig = getUIConfig()

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
      totalRounds: roundInfo.total,
      remainingTime: '',
      nextRoundTime: roundInfo.countdown,
      isClosed: true,

      currentProducts: [],
      otherPeriods,
    }
  }

  /**
   * 加载昨日历史商品数据（用于闭市时段和第1轮显示）
   * 兼容JSON文件不存在或仅包含部分轮次数据的情况
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
      return segment.image(img)
    } catch (error) {
      logger.error(`[${LOG_TAG}] 渲染图片失败: ${error.message}`)
      return false
    }
  }

  // ========== 用户命令 ==========

  async queryMerchant(e) {
    try {
      await this.ensureReady()
      const roundInfo = getRoundInfo()

      // 0:00-8:00 闭市时段：不爬取，显示昨日已过期商品
      if (roundInfo.status === 'closed') {
        const renderData = this.prepareClosedData(roundInfo)
        const result = await this.renderImage(renderData)
        if (result) {
          await this.reply(result)
        } else {
          await this.reply(`今日已闭市\n下一轮：${roundInfo.countdown}`)
        }
        return true
      }

      // 获取数据
      const data = await this.crawler.getData(false)

      if (!data || !data.success) {
        const errorMsg = data?.error || '无法获取数据，请稍后重试'
        await this.reply(`获取失败: ${errorMsg}`)
        return false
      }

      if (data.productCount === 0) {
        let statusMsg = ''
        if (roundInfo.status === 'waiting') {
          statusMsg = `商人即将刷新\n预计时间：${roundInfo.detectionStartTime}`
        } else {
          statusMsg = `当前轮次暂无商品\n时段：${roundInfo.timeLabel}\n\n可能原因：\n- 商人尚未刷新商品\n- 网页数据正在更新中`
        }
        await this.reply(statusMsg)
        return true
      }

      // 补全缺失的图标（渲染前确保图标就绪）
      await this._ensureIcons(data.products)

      // 渲染图片
      const renderData = this.prepareRenderData(data)
      const result = await this.renderImage(renderData)

      if (result) {
        await this.reply(result)
        return true
      } else {
        await this.reply('图片生成失败，请稍后重试')
        return false
      }

    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询异常: ${error.message}`)
      await this.reply(`查询出错: ${error.message}`)
      return false
    }
  }

  async showStatus(e) {
    try {
      await this.ensureReady()
      const roundInfo = getRoundInfo()
      const cacheStatus = this.crawler.cache.getStatus()
      const pushStatus = this.pushService.getStatus()

      let statusText = `远行商人系统状态\n`
      statusText += `--------------------\n`
      statusText += `当前时间：${getBeijingTime().format('YYYY-MM-DD HH:mm:ss')}\n`
      statusText += `轮次：第 ${roundInfo.current}/${roundInfo.total} 轮\n`
      statusText += `时段：${roundInfo.timeLabel}\n`
      statusText += `倒计时：${roundInfo.countdown}\n`
      statusText += `检测状态：${roundInfo.status === 'active' ? '检测中' : roundInfo.status === 'waiting' ? '等待中' : '未开放'}\n`

      if (cacheStatus.today.exists) {
        statusText += `\n今日缓存：${cacheStatus.today.valid ? '有效' : '已过期'}\n`
        if (cacheStatus.today.productCount !== undefined) {
          statusText += `  商品数：${cacheStatus.today.productCount}件\n`
          statusText += `  缓存时间：${cacheStatus.today.cachedAt}\n`
          statusText += `  缓存时长：${cacheStatus.today.age}\n`
        }
      } else {
        statusText += `\n今日缓存：不存在\n`
      }

      if (cacheStatus.history.exists) {
        statusText += `\n历史记录：存在 (${cacheStatus.history.recordCount || 0}条)\n`
        statusText += `  最后更新：${cacheStatus.history.updatedAt || '--'}\n`
      } else {
        statusText += `\n历史记录：暂无\n`
      }

      statusText += `\n渲染器：框架内置 (scale=3)\n`
      statusText += `\n推送状态：${pushStatus.enabled ? '已启用' : '未启用'}\n`
      if (pushStatus.enabled) {
        statusText += `  订阅数：${pushStatus.subscriptionStats.total} (群${pushStatus.subscriptionStats.groups} 私${pushStatus.subscriptionStats.private})\n`
        if (pushStatus.lastPushedRound !== null) {
          statusText += `  上次推送：第${pushStatus.lastPushedRound}轮\n`
        }
      }

      await this.reply(statusText)
      return true

    } catch (error) {
      logger.error(`[${LOG_TAG}] 状态查询异常: ${error.message}`)
      await this.reply(`状态查询失败: ${error.message}`)
      return false
    }
  }

  async forceRefresh(e) {
    try {
      await this.ensureReady()
      await this.reply('正在强制刷新远行商人数据...')

      this.roundDataFetched = false
      await this.crawler.cache.clearAll()

      const data = await this.crawler.getData(true)

      if (!data || !data.success) {
        await this.reply(`刷新失败: ${data?.error || '未知错误'}`)
        return false
      }

      if (data.productCount > 0) {
        // 补全图标
        await this._ensureIcons(data.products)

        const renderData = this.prepareRenderData(data)
        const result = await this.renderImage(renderData)

        if (result) {
          await this.reply(result)
          return true
        }
      }

      const names = (data.products || []).map(p => p.name).join('、')
      await this.reply(`刷新成功！当前售卖：${names || '暂无商品'}`)
      return true

    } catch (error) {
      logger.error(`[${LOG_TAG}] 强制刷新异常: ${error.message}`)
      await this.reply(`刷新失败: ${error.message}`)
      return false
    }
  }

  // ========== 订阅管理命令 ==========

  async subscribeMerchant(e) {
    try {
      await this.ensureReady()

      if (!this.pushService.isEnabled()) {
        await this.reply('推送功能未启用，请联系管理员开启')
        return false
      }

      const isGroup = e.isGroup
      const type = isGroup ? 'group' : 'private'
      const id = isGroup ? e.group_id : e.user_id

      if (!id) {
        await this.reply('无法识别目标，请稍后重试')
        return false
      }

      const result = this.subscriptionManager.subscribe({
        type,
        id: String(id),
        subscribedBy: String(e.user_id),
        group_id: isGroup ? String(e.group_id) : undefined,
      })

      if (result.ok) {
        const targetDesc = isGroup ? `本群` : '你'
        await this.reply(`${targetDesc}已成功订阅远行商人推送\n每轮商人刷新后将自动推送商品信息`)
      } else {
        await this.reply(result.msg)
      }

      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 订阅异常: ${error.message}`)
      await this.reply(`订阅失败: ${error.message}`)
      return false
    }
  }

  async unsubscribeMerchant(e) {
    try {
      await this.ensureReady()

      const isGroup = e.isGroup
      const type = isGroup ? 'group' : 'private'
      const id = isGroup ? e.group_id : e.user_id

      if (!id) {
        await this.reply('无法识别目标，请稍后重试')
        return false
      }

      const result = this.subscriptionManager.unsubscribe(type, String(id))

      if (result.ok) {
        const targetDesc = isGroup ? `本群` : '你'
        await this.reply(`${targetDesc}已取消远行商人订阅`)
      } else {
        await this.reply(result.msg)
      }

      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 取消订阅异常: ${error.message}`)
      await this.reply(`取消订阅失败: ${error.message}`)
      return false
    }
  }

  async showSubscriptionStatus(e) {
    try {
      await this.ensureReady()

      const isGroup = e.isGroup
      const type = isGroup ? 'group' : 'private'
      const id = isGroup ? e.group_id : e.user_id

      const sub = this.subscriptionManager.getSubscription(type, String(id))
      const pushConfig = getPushConfig()

      let msg = '远行商人订阅状态\n'
      msg += '--------------------\n'
      msg += `推送功能：${pushConfig.enabled !== false ? '已启用' : '未启用'}\n`

      if (sub) {
        msg += `订阅状态：已订阅\n`
        msg += `订阅时间：${sub.subscribedAt}\n`
        msg += `订阅类型：${sub.type === 'group' ? '群聊推送' : '私聊推送'}\n`

        const roundInfo = getRoundInfo()
        msg += `\n当前时段：第${roundInfo.current}轮 ${roundInfo.timeLabel}\n`
        msg += `下一轮推送将在新时段刷新后自动发送`
      } else {
        msg += `订阅状态：未订阅\n`
        msg += `\n发送 #远行商人订阅 即可订阅推送`
      }

      await this.reply(msg)
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询订阅状态异常: ${error.message}`)
      await this.reply(`查询失败: ${error.message}`)
      return false
    }
  }

  async listSubscriptions(e) {
    try {
      await this.ensureReady()

      const all = this.subscriptionManager.getAll()
      const stats = this.subscriptionManager.getStats()

      let msg = `远行商人订阅列表\n`
      msg += `--------------------\n`
      msg += `总计：${stats.total} 个订阅 (群${stats.groups} 私${stats.private})\n\n`

      if (all.length === 0) {
        msg += '暂无订阅'
      } else {
        for (let i = 0; i < all.length; i++) {
          const sub = all[i]
          const typeLabel = sub.type === 'group' ? '群' : '私'
          msg += `${i + 1}. [${typeLabel}] ${sub.id} - ${sub.subscribedAt}\n`
        }
      }

      await this.reply(msg)
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 列出订阅异常: ${error.message}`)
      await this.reply(`查询失败: ${error.message}`)
      return false
    }
  }

  async testPush(e) {
    try {
      await this.ensureReady()

      if (!this.pushService.isEnabled()) {
        await this.reply('推送功能未启用')
        return false
      }

      const subscriptions = this.subscriptionManager.getAll()
      if (subscriptions.length === 0) {
        await this.reply('暂无订阅者，无法测试推送')
        return false
      }

      await this.reply(`开始推送测试，共 ${subscriptions.length} 个订阅...`)

      const roundInfo = getRoundInfo()
      let merchantImage = null

      if (roundInfo.status !== 'closed') {
        const data = await this.crawler.getData(false)
        if (data?.success && data.productCount > 0) {
          await this._ensureIcons(data.products)
          const renderData = this.prepareRenderData(data)
          merchantImage = await this.renderImage(renderData)
        }
      }

      // 重置推送状态以允许测试推送
      this.pushService.resetPushState()

      const result = await this.pushService.pushToAll(merchantImage, {
        roundInfo,
        products: [],
        success: true,
      })

      await this.reply(`推送测试完成\n总计: ${result.total}\n成功: ${result.success}\n失败: ${result.failed}`)
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 推送测试异常: ${error.message}`)
      await this.reply(`推送测试失败: ${error.message}`)
      return false
    }
  }

  // ========== 定时检测与推送 ==========

  /**
   * 定时调度检测
   *
   * 规则:
   * - 0:00-8:00 闭市时段：禁止爬取、禁止推送
   * - 8:00-12:00 第1轮：等待1分钟后开始抓取，成功后停止，最多30次
   * - 12:00-16:00 第2轮：执行抓取
   * - 16:00-20:00 第3轮：执行抓取
   * - 20:00-24:00 第4轮：执行抓取
   */
  async scheduleDetection() {
    try {
      const roundInfo = getRoundInfo()

      // 闭市时段：禁止爬取和推送
      if (roundInfo.status === 'closed') {
        return
      }

      // 等待中（轮次刚开始但还在延迟期内）：跳过
      if (roundInfo.status === 'waiting') {
        return
      }

      // 检测新轮次
      if (roundInfo.current !== this.currentRoundIndex) {
        this.currentRoundIndex = roundInfo.current
        this.roundDataFetched = false
        logger.mark(`[${LOG_TAG}] 第${roundInfo.current}轮 ${roundInfo.timeLabel}`)
      }

      // 已获取过本轮数据或正在检测中：跳过
      if (this.roundDataFetched || this.crawler.isDetecting) {
        return
      }

      // 检查今日缓存是否已有本轮有效数据
      try {
        const cached = await this.crawler.cache.getToday()
        if (cached && this.crawler.cache.isValid(cached) && cached.productCount > 0) {
          // 缓存有效，标记本轮已获取
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
      await this._ensureIcons(data.products)

      // 2. 渲染图片
      let merchantImage = null
      if (data.productCount > 0) {
        const renderData = this.prepareRenderData(data)
        merchantImage = await this.renderImage(renderData)
      }

      // 3. 推送
      await this.pushService.pushToAll(merchantImage, data)
    } catch (error) {
      logger.error(`[${LOG_TAG}] 推送执行异常: ${error.message}`)
    }
  }

  /**
   * 确保商品图标已下载到本地
   * 在渲染和推送前调用，保证图片能正常显示
   */
  async _ensureIcons(products) {
    if (!products || products.length === 0) return

    // 只对有icon URL且本地缺失的商品尝试下载
    const needDownload = products.filter(p =>
      p.name && !this.crawler.iconManager.hasIcon(p.name) && p.icon
    )
    if (needDownload.length > 0) {
      logger.debug(`[${LOG_TAG}] 补全图标: ${needDownload.length} 个缺失`)
      await this.crawler.iconManager.batchDownloadIcons(needDownload, 3)
    }
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
