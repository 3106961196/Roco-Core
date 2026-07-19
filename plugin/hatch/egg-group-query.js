/**
 * 蛋组查询：格式化与编排
 */
import {
  getEggGroupPets,
  findPetByName,
  eggGroupsOverlap,
  listEggGroupPartners,
} from './egg-groups.js'

const MAX_LIST = 40

function formatPetBrief(p) {
  const shiny = p.shiny ? '·异色' : ''
  return `No.${String(p.id).padStart(3, '0')} ${p.name}${shiny}`
}

function formatAmbiguous(list) {
  return `匹配到多只，请写全名：\n${list.map((p) => `· ${formatPetBrief(p)}`).join('\n')}`
}

/**
 * @param {string} name
 * @param {{ baseUrl?: string, force?: boolean }} [opts]
 */
export async function queryEggGroup(name, opts = {}) {
  const bundle = await getEggGroupPets(opts)
  const found = findPetByName(bundle.pets, name)
  if (!found) {
    return { ok: false, message: `未找到精灵「${name}」` }
  }
  if (found.ambiguous && !found.pet) {
    return { ok: false, message: formatAmbiguous(found.ambiguous) }
  }

  const pet = found.pet
  const partners = listEggGroupPartners(bundle.pets, pet)
  const shinyCount = partners.filter((p) => p.shiny).length
  return {
    ok: true,
    pet,
    partners,
    shinyCount,
    pageUrl: `${String(opts.baseUrl || 'https://luokewangguofudan.wiki').replace(/\/+$/, '')}/egg-groups?pet=${encodeURIComponent(pet.name)}`,
  }
}

/**
 * 两只精灵是否可配对
 */
export async function queryEggPair(nameA, nameB, opts = {}) {
  const bundle = await getEggGroupPets(opts)
  const a = findPetByName(bundle.pets, nameA)
  const b = findPetByName(bundle.pets, nameB)

  if (!a?.pet && a?.ambiguous) return { ok: false, message: `第一只：${formatAmbiguous(a.ambiguous)}` }
  if (!a?.pet) return { ok: false, message: `未找到精灵「${nameA}」` }
  if (!b?.pet && b?.ambiguous) return { ok: false, message: `第二只：${formatAmbiguous(b.ambiguous)}` }
  if (!b?.pet) return { ok: false, message: `未找到精灵「${nameB}」` }

  const compatible = eggGroupsOverlap(a.pet, b.pet)
  return {
    ok: true,
    petA: a.pet,
    petB: b.pet,
    compatible,
    pageUrl: `${String(opts.baseUrl || 'https://luokewangguofudan.wiki').replace(/\/+$/, '')}/egg-groups`,
  }
}

export function formatEggGroupText(result) {
  if (!result.ok) return result.message
  const { pet, partners, shinyCount, pageUrl } = result
  const groups = (pet.eggGroups || []).join('/')
  const others = partners.filter((p) => p.id !== pet.id)
  const show = others.slice(0, MAX_LIST)
  const more = others.length > MAX_LIST ? `\n…另有 ${others.length - MAX_LIST} 只，详见 ${pageUrl}` : ''
  const lines = show.map((p) => formatPetBrief(p))
  return [
    `生蛋查询：${pet.name}`,
    `${pet.classisName || '未分类'} · 蛋组 ${groups}`,
    `可配对 ${others.length} 只（含异色 ${shinyCount}）`,
    lines.join('\n') + more,
    '来源：灵蛋所',
  ].join('\n')
}

export function formatEggPairText(result) {
  if (!result.ok) return result.message
  const { petA, petB, compatible } = result
  const ga = (petA.eggGroups || []).join('/')
  const gb = (petB.eggGroups || []).join('/')
  return [
    `生蛋配对：${petA.name} × ${petB.name}`,
    `${petA.name} 蛋组 ${ga}`,
    `${petB.name} 蛋组 ${gb}`,
    compatible ? '结果：可配对（蛋组有重叠）' : '结果：不可配对（蛋组无重叠）',
    '来源：灵蛋所',
  ].join('\n')
}

/** 解析「#生蛋 喵喵」或「#生蛋 喵喵 火花」 */
export function parseEggGroupArgs(msg) {
  const text = String(msg || '')
    .replace(/^#?(生蛋|蛋组)(查询|配对)?/i, '')
    .trim()
  if (!text) return null
  const parts = text.split(/[\s+＋与和×xX,，]+/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null
  if (parts.length === 1) return { mode: 'list', name: parts[0] }
  return { mode: 'pair', nameA: parts[0], nameB: parts[1] }
}
