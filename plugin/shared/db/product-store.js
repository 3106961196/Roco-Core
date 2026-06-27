const LOG_TAG = '洛克王国-远行商人'
const COLLECTION = 'roco_merchant_products'

/**
 * 商品数据存储 - MongoDB
 *
 * 集合：roco_merchant_products
 * 结构：{ date, round, name, price, buyLimit }
 *
 * round 含义：
 * - 0: 多轮次商品（跨时段）
 * - 1-4: 第1-4轮商品
 * - 5: 闭店时段商品
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
      await this._collection.createIndex({ date: 1, round: 1 })
      await this._collection.createIndex({ date: 1, name: 1 })

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
   * @param {Array} products - 商品列表，每个商品包含 { name, price, buyLimit, round }
   * @param {object} context - 上下文 { date }
   */
  async saveProducts(products, context) {
    if (!products?.length) return

    // 防御性检查：collection 失效时尝试重新初始化
    if (!this._collection) {
      logger.debug(`[${LOG_TAG}] MongoDB collection 失效，尝试重新初始化`)
      this._initialized = false
      await this.init()
      if (!this._collection) {
        logger.warn(`[${LOG_TAG}] MongoDB 重新初始化失败，跳过存储`)
        return
      }
    }

    const { date } = context

    const docs = products.map(p => ({
      date,
      round: p.round || 0,
      name: p.name,
      price: p.price,
      buyLimit: p.buyLimit || '-',
    }))

    try {
      await this._collection.insertMany(docs, { ordered: false })
      logger.debug(`[${LOG_TAG}] 保存 ${docs.length} 个商品到 MongoDB`)
    } catch (error) {
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
        .sort({ round: 1 })
        .toArray()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询日期 ${date} 失败: ${error.message}`)
      return []
    }
  }

  /**
   * 按日期和轮次查询
   * @param {string} date - YYYY-MM-DD
   * @param {number} round - 轮次 (0-5)
   */
  async getByDateAndRound(date, round) {
    if (!this.isAvailable) return []

    try {
      return await this._collection
        .find({ date, round })
        .toArray()
    } catch (error) {
      logger.error(`[${LOG_TAG}] 查询 ${date} round=${round} 失败: ${error.message}`)
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
        .sort({ date: -1 })
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
}

// 单例
let instance

export function getProductStore() {
  if (!instance) instance = new ProductStore()
  return instance
}
