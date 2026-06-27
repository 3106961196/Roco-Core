const LOG_TAG = '洛克王国-远行商人'
const COLLECTION = 'roco_merchant_products'

/**
 * 商品数据存储 - MongoDB
 *
 * 集合：roco_merchant_products
 * 结构：{ date, round, slotIndex, timeLabel, name, price, buyLimit, status, recordedAt, expireTimestamp }
 */
class ProductStore {
  constructor() {
    this._collection = null
    this._initialized = false
  }

  async init() {
    if (this._initialized) return

    try {
      const db = globalThis.mongodbDb
      if (!db) {
        logger.warn(`[${LOG_TAG}] MongoDB 未初始化，商品数据将仅存储在缓存`)
        return
      }

      this._collection = db.collection(COLLECTION)

      // 创建索引
      await this._collection.createIndex({ date: 1, name: 1 })
      await this._collection.createIndex({ date: 1, round: 1 })
      await this._collection.createIndex({ name: 1, recordedAt: -1 })

      this._initialized = true
      logger.mark(`[${LOG_TAG}] MongoDB 商品存储初始化成功`)
    } catch (error) {
      logger.error(`[${LOG_TAG}] MongoDB 初始化失败: ${error.message}`)
    }
  }

  get collection() {
    return this._collection
  }

  get isAvailable() {
    return this._initialized && this._collection !== null
  }

  /**
   * 批量保存商品数据
   * @param {Array} products - 商品列表
   * @param {object} context - 上下文 { date, round, slotIndex, timeLabel }
   */
  async saveProducts(products, context) {
    if (!this.isAvailable || !products?.length) return

    const { date, round, slotIndex, timeLabel } = context
    const now = new Date()

    const docs = products.map(p => ({
      date,
      round,
      slotIndex,
      timeLabel,
      name: p.name,
      price: p.price,
      buyLimit: p.buyLimit || '-',
      status: p.status || 'active',
      recordedAt: now,
      expireTimestamp: p.expireTimestamp || 0,
    }))

    try {
      await this._collection.insertMany(docs, { ordered: false })
      logger.debug(`[${LOG_TAG}] 保存 ${docs.length} 个商品到 MongoDB`)
    } catch (error) {
      // 忽略重复键错误（如果存在唯一索引）
      if (error.code !== 11000) {
        logger.error(`[${LOG_TAG}] 保存商品失败: ${error.message}`)
      }
    }
  }

  /**
   * 按日期查询商品
   * @param {string} date - YYYY-MM-DD
   */
  async getByDate(date) {
    if (!this.isAvailable) return []

    try {
      return await this._collection
        .find({ date })
        .sort({ round: 1, slotIndex: 1 })
        .toArray()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询日期 ${date} 失败: ${error.message}`)
      return []
    }
  }

  /**
   * 按日期和轮次查询
   * @param {string} date - YYYY-MM-DD
   * @param {number} round - 轮次
   */
  async getByDateAndRound(date, round) {
    if (!this.isAvailable) return []

    try {
      return await this._collection
        .find({ date, round })
        .sort({ slotIndex: 1 })
        .toArray()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询 ${date} 第${round}轮失败: ${error.message}`)
      return []
    }
  }

  /**
   * 按商品名查询历史记录
   * @param {string} name - 商品名
   * @param {number} limit - 返回条数限制
   */
  async getByName(name, limit = 30) {
    if (!this.isAvailable) return []

    try {
      return await this._collection
        .find({ name: { $regex: name, $options: 'i' } })
        .sort({ recordedAt: -1 })
        .limit(limit)
        .toArray()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询商品 ${name} 失败: ${error.message}`)
      return []
    }
  }

  /**
   * 统计商品出现次数
   * @param {string} name - 商品名
   */
  async countByName(name) {
    if (!this.isAvailable) return 0

    try {
      return await this._collection.countDocuments({
        name: { $regex: name, $options: 'i' }
      })
    } catch (error) {
      logger.error(`[${LOG_TAG}] 统计商品 ${name} 失败: ${error.message}`)
      return 0
    }
  }

  /**
   * 获取最近 N 天的商品记录
   * @param {number} days - 天数
   */
  async getRecent(days = 7) {
    if (!this.isAvailable) return []

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)

    try {
      return await this._collection
        .find({ recordedAt: { $gte: cutoff } })
        .sort({ recordedAt: -1 })
        .toArray()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询最近记录失败: ${error.message}`)
      return []
    }
  }
}

// 单例
let instance = null
export function getProductStore() {
  if (!instance) instance = new ProductStore()
  return instance
}

export default ProductStore
