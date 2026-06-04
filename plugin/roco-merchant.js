import MerchantCrawler from './shared/crawler.js'
import MerchantRenderer from './shared/renderer.js'
import MerchantScheduler from './shared/scheduler.js'
import PushService from './shared/push-service.js'
import SubscriptionManager from './shared/subscription-manager.js'
import { getBeijingTime, getRoundInfo } from './shared/time-utils.js'
import { getUIConfig, getPushConfig } from './shared/config.js'

const LOG_TAG = '洛克王国-远行商人'

// 模块级单例锁：跨实例共享组件（防止 plugin 被多次实例化导致重复执行）
let _sharedComponents = null

/**
 * 远行商人插件 - 入口
 *
 * 职责：
 * - 解析用户命令 (#远行商人 / 订阅 / 状态 / 强制刷新 等)
 * - 路由到对应的 service / scheduler
 *
 * 不再持有以下细节（已迁出）：
 * - 抓取 / 缓存 → shared/crawler.js
 * - 渲染数据准备 / 图片渲染 → shared/renderer.js
 * - 定时调度 / 补抓 / 推送触发 → shared/scheduler.js
 * - 推送 / 订阅 / 历史 → shared/push-service.js + subscription-manager.js
 */
export class RocoMerchant extends plugin {
  constructor() {
    super({
      name: '洛克王国-远行商人',
      dsc: '远行商人商品查询与智能推送',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#?远行商人$', fnc: 'queryMerchant', log: true },
        { reg: '^#?远行商人订阅$', fnc: 'subscribeMerchant', log: true },
        { reg: '^#强制刷新远行人$', fnc: 'forceRefresh', permission: 'master', log: true },
        { reg: '^#?远行商人状态$', fnc: 'showStatus', permission: 'master', log: true },
        { reg: '^#?远行商人取消订阅$', fnc: 'unsubscribeMerchant', permission: 'master', log: true },
        { reg: '^#?远行商人订阅列表$', fnc: 'listSubscriptions', permission: 'master', log: true },
        { reg: '^#?远行商人推送测试$', fnc: 'testPush', permission: 'master', log: true },
      ],
    })
  }

  /**
   * 初始化：构造 crawler / renderer / scheduler（单例）
   * 框架首次调用 rule 中的方法前会自动调用 init()
   */
  async init() {
    if (this._initPromise) return this._initPromise
    this._initPromise = this._doInit()
    return this._initPromise
  }

  async _doInit() {
    if (_sharedComponents && _sharedComponents._initialized) {
      logger.debug(`[${LOG_TAG}] 插件已初始化，共享单例组件`)
      this.bindComponents(_sharedComponents)
      return
    }

    const crawler = new MerchantCrawler()
    const subscriptionManager = new SubscriptionManager()
    const pushService = new PushService(subscriptionManager)
    const renderer = new MerchantRenderer({ crawler })
    const scheduler = new MerchantScheduler({
      crawler,
      renderer,
      subscriptionManager,
      pushService,
    })

    this.bindComponents({ crawler, renderer, scheduler, subscriptionManager, pushService })
    await scheduler.init()
    _sharedComponents = this.components
  }

  /**
   * 把组件绑定到 this 上，方便命令方法访问
   */
  bindComponents(components) {
    this.components = components
    this.crawler = components.crawler
    this.renderer = components.renderer
    this.scheduler = components.scheduler
    this.subscriptionManager = components.subscriptionManager
    this.pushService = components.pushService
  }

  // ========== 用户命令 ==========

  async queryMerchant(e) {
    try {
      await this.init()
      const roundInfo = getRoundInfo()

      // 0:00-8:00 闭市时段：不爬取，显示昨日已过期商品
      if (roundInfo.status === 'closed') {
        const renderData = this.renderer.prepareClosedData(roundInfo)
        const result = await this.renderer.renderImage(renderData)
        if (result) {
          await this.reply(segment.image(result))
        } else {
          await this.reply(`今日已闭市\n下一轮：${roundInfo.countdown}`)
        }
        return true
      }

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

      await this.renderer.ensureIcons(data.products)
      const renderData = this.renderer.prepareRenderData(data)
      const result = await this.renderer.renderImage(renderData)
      if (result) {
        await this.reply(segment.image(result))
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
      await this.init()
      const roundInfo = getRoundInfo()
      const cacheStatus = this.crawler.cache.getStatus()
      const historyStatus = this.crawler.historyCache.getStatus()
      const pushStatus = this.pushService.getStatus()
      const pushConfig = getPushConfig()

      const isGroup = e.isGroup
      const type = isGroup ? 'group' : 'private'
      const id = isGroup ? e.group_id : e.user_id
      const sub = id ? this.subscriptionManager.getSubscription(type, String(id)) : null

      let msg = '远行商人订阅状态\n'
      msg += '--------------------\n'
      msg += `当前时间：${getBeijingTime().format('YYYY-MM-DD HH:mm:ss')}\n`
      msg += `轮次：第 ${roundInfo.current}/${roundInfo.total} 轮\n`
      msg += `时段：${roundInfo.timeLabel}\n`
      msg += `倒计时：${roundInfo.countdown}\n`
      msg += `检测状态：${roundInfo.status === 'active' ? '检测中' : roundInfo.status === 'waiting' ? '等待中' : '未开放'}\n`

      if (cacheStatus.today.exists) {
        msg += `\n今日缓存：${cacheStatus.today.valid ? '有效' : '已过期'}\n`
        if (cacheStatus.today.productCount !== undefined) {
          msg += `  商品数：${cacheStatus.today.productCount}件\n`
          msg += `  缓存时间：${cacheStatus.today.cachedAt}\n`
          msg += `  缓存时长：${cacheStatus.today.age}\n`
        }
      } else {
        msg += `\n今日缓存：不存在\n`
      }

      if (historyStatus.exists) {
        msg += `\n历史记录：存在 (${historyStatus.recordCount || 0}条)\n`
        msg += `  最后更新：${historyStatus.updatedAt || '--'}\n`
      } else {
        msg += `\n历史记录：暂无\n`
      }

      msg += `\n推送功能：${pushConfig.enabled !== false ? '已启用' : '未启用'}\n`
      if (pushStatus.enabled) {
        msg += `  订阅数：${pushStatus.subscriptionStats.total} (群${pushStatus.subscriptionStats.groups} 私${pushStatus.subscriptionStats.private})\n`
        if (pushStatus.lastPushedRound !== null) {
          msg += `  上次推送：第${pushStatus.lastPushedRound}轮\n`
        }
      }

      if (sub) {
        msg += `\n本${isGroup ? '群' : '你'}订阅：已订阅\n`
        msg += `  订阅时间：${sub.subscribedAt}\n`
        msg += `  下一轮推送将在新时段刷新后自动发送`
      } else {
        msg += `\n本${isGroup ? '群' : '你'}订阅：未订阅\n`
        msg += `  发送 #远行商人订阅 即可订阅推送`
      }

      await this.reply(msg)
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 状态查询异常: ${error.message}`)
      await this.reply(`状态查询失败: ${error.message}`)
      return false
    }
  }

  async forceRefresh(e) {
    try {
      await this.init()
      await this.reply('正在强制刷新远行商人数据...')

      const data = await this.scheduler.forceRefresh()
      if (!data || !data.success) {
        await this.reply(`刷新失败: ${data?.error || '未知错误'}`)
        return false
      }

      if (data.productCount > 0) {
        await this.renderer.ensureIcons(data.products)
        const renderData = this.renderer.prepareRenderData(data)
        const result = await this.renderer.renderImage(renderData)
        if (result) {
          await this.reply(segment.image(result))
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

  async subscribeMerchant(e) {
    try {
      await this.init()
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
      await this.init()
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

  async listSubscriptions(e) {
    try {
      await this.init()
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
      await this.init()
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
          await this.renderer.ensureIcons(data.products)
          const renderData = this.renderer.prepareRenderData(data)
          merchantImage = await this.renderer.renderImage(renderData)
        }
      }

      this.pushService.resetPushState()
      const result = await this.pushService.pushToAll(merchantImage, {
        roundInfo,
        products: [],
        success: true,
      }, { isTest: true })

      await this.reply(`推送测试完成\n总计: ${result.total}\n成功: ${result.success}\n失败: ${result.failed}`)
      return true
    } catch (error) {
      logger.error(`[${LOG_TAG}] 推送测试异常: ${error.message}`)
      await this.reply(`推送测试失败: ${error.message}`)
      return false
    }
  }

  async destroy() {
    if (this.scheduler) {
      await this.scheduler.destroy()
    }
  }
}
