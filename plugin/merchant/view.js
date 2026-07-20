/**
 * 远行商人渲染 — RendererLoader + resources/远行商人/merchant.html
 */
import fs from 'node:fs'
import path from 'node:path'
import paths from '#utils/paths.js'
import Renderer from '#infrastructure/renderer/Renderer.js'
import RendererLoader from '#infrastructure/renderer/loader.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { getUIConfig } from './config.js'
import { isOvernightSlot } from './crawl.js'

const LOG_TAG = '远行商人-渲染'
const TPL_DIR = path.join(paths.root, 'core/Roco-Core/resources/远行商人')
const TPL_FILE = path.join(TPL_DIR, 'merchant.html')

const nowLabel = () =>
  new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

/** 距本档结束的剩余时间文案（模板：剩余 {{ remainingTime }}） */
function formatRemaining(slot, now = new Date()) {
  if (!slot || slot.overnight || !slot.endHour) return ''
  const end = new Date(now)
  end.setSeconds(0, 0)
  if (slot.endHour === 24) {
    end.setDate(end.getDate() + 1)
    end.setHours(0, 0, 0, 0)
  } else {
    end.setHours(slot.endHour, 0, 0, 0)
  }
  const sec = Math.max(0, Math.floor((end - now) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}小时${m}分钟`
  return `${m}分钟`
}

function parsePrice(priceStr) {
  if (!priceStr || priceStr === '未知') return 0
  const price = String(priceStr).trim()
  if (/[wW]/.test(price)) return parseFloat(price.replace(/[wW]/g, '')) * 10000
  if (price.includes('万')) return parseFloat(price.replace(/万/, '')) * 10000
  const num = parseFloat(price)
  return Number.isFinite(num) ? num : 0
}

/** @param {{ slot, shelf, expiredRows, overnight }} view */
export function buildRenderData(view) {
  const ui = getUIConfig()
  const closed = view.overnight || isOvernightSlot(view.slot)
  const items = closed ? [] : (view.shelf?.items || [])

  const currentProducts = items.map((p) => {
    const priceNum = parsePrice(p.price)
    const limitNum = Number(p.limit) || 0
    const totalCost = priceNum * limitNum
    return {
      name: p.name,
      iconUrl: p.icon || '',
      price: p.price || '未知',
      priceDisplay: priceNum > 0 ? priceNum.toLocaleString() : p.price || '未知',
      limit: p.limit ?? '-',
      totalCost,
      totalCostDisplay: totalCost > 0 ? totalCost.toLocaleString() : '-',
      isRecommended: !!p.isRecommended,
    }
  })

  return {
    saveId: `merchant_${Date.now()}`,
    tplFile: TPL_FILE,
    imgType: ui.format,
    quality: ui.imageQuality,
    sys: { scale: 2 },
    resPrefix: `${Renderer.toFileUrl(TPL_DIR)}/`,
    date: nowLabel(),
    currentRound: closed ? 0 : (view.slot?.showN || 0),
    totalRounds: 4,
    remainingTime: closed ? '' : formatRemaining(view.slot),
    nextRoundTime: closed ? '明日 08:00 开市' : '',
    isClosed: closed,
    currentProducts,
    otherPeriods: (view.expiredRows || [])
      .filter((r) => r.items?.length)
      .map((r) => ({
        time: r.label || r.key,
        status: 'ended',
        products: r.items.map((p) => ({
          name: p.name,
          iconUrl: p.icon || '',
          isRecommended: !!p.isRecommended,
        })),
      })),
  }
}

export function formatTextFallback(view) {
  if (view.overnight || isOvernightSlot(view.slot)) {
    return '【远行商人】当前已收市，明日 08:00 开市'
  }
  const items = view.shelf?.items || []
  const head = `【远行商人】${view.slot?.label || ''}`
  if (!items.length) return `${head}\n\n本轮暂无商品`
  return [head, '', ...items.flatMap((p) => [`${p.name}\n价格:${p.price} 限购:${p.limit}`, ''])]
    .join('\n')
    .trim()
}

export async function renderMerchantImage(view) {
  await RendererLoader.ensureLoaded()
  const renderer = RendererLoader.getRenderer()
  if (!renderer) {
    RuntimeUtil.makeLog('warn', 'RendererLoader 未就绪', LOG_TAG)
    return null
  }
  try {
    // trash 清理会删掉 html 目录，dealTpl 写文件前需重建
    fs.mkdirSync('./trash/html/远行商人', { recursive: true })
    const img = await renderer.render('远行商人', buildRenderData(view))
    if (!img) return null
    return Array.isArray(img) ? img[0] : img
  } catch (err) {
    RuntimeUtil.makeLog('error', `截图失败: ${err?.message || err}`, LOG_TAG)
    return null
  }
}
