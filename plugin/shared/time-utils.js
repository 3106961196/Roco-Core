import moment from 'moment-timezone'
import { getMerchantConfig, getDetectionConfig } from './config.js'

const TIMEZONE = 'Asia/Shanghai'

function getRefreshTimes() {
  const merchantConfig = getMerchantConfig()
  return merchantConfig.dataSources?.[0]?.refreshTimes || ['08:00', '12:00', '16:00', '20:00']
}

function getDetectionDelayMinutes() {
  const detectionConfig = getDetectionConfig()
  return detectionConfig.delayMinutes || 1
}

export function getBeijingTime() {
  return moment().tz(TIMEZONE)
}

export function getRoundInfo() {
  const now = getBeijingTime()
  const todayStart = now.clone().startOf('day')
  const REFRESH_TIMES = getRefreshTimes()
  const DETECTION_DELAY_MINUTES = getDetectionDelayMinutes()

  for (let i = 0; i < REFRESH_TIMES.length; i++) {
    const [hour, minute] = REFRESH_TIMES[i].split(':').map(Number)
    const roundStart = todayStart.clone().hour(hour).minute(minute).second(0)
    const roundEnd = i < REFRESH_TIMES.length - 1
      ? (() => {
          const [nextHour, nextMinute] = REFRESH_TIMES[i + 1].split(':').map(Number)
          return todayStart.clone().hour(nextHour).minute(nextMinute).second(0)
        })()
      : todayStart.clone().endOf('day')

    const detectionStart = roundStart.clone().add(DETECTION_DELAY_MINUTES, 'minutes')

    if (now.isBetween(roundStart, roundEnd)) {
      const remaining = roundEnd.diff(now, 'seconds')
      return {
        current: i + 1,
        total: REFRESH_TIMES.length,
        startTime: roundStart.format('HH:mm'),
        endTime: roundEnd.format('HH:mm'),
        detectionStartTime: detectionStart.format('HH:mm:ss'),
        countdown: formatCountdown(remaining),
        remainingSeconds: remaining,
        status: now.isBefore(detectionStart) ? 'waiting' : 'active',
        timeLabel: `${roundStart.format('HH:mm')} - ${roundEnd.format('HH:mm')}`
      }
    }
  }

  const nextDayStart = now.clone().add(1, 'day').startOf('day')
  const [firstHour, firstMinute] = REFRESH_TIMES[0].split(':').map(Number)
  const nextRound = nextDayStart.clone().hour(firstHour).minute(firstMinute).second(0)

  return {
    current: 0,
    total: REFRESH_TIMES.length,
    status: 'closed',
    countdown: `下一轮 ${nextRound.format('MM-DD HH:mm')}`,
    remainingSeconds: nextRound.diff(now, 'seconds'),
    timeLabel: '尚未开市'
  }
}

function formatCountdown(seconds) {
  if (seconds <= 0) return '已结束'

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  let result = ''
  if (hours > 0) result += `${hours}小时`
  if (minutes > 0 || hours === 0) result += `${minutes}分钟`

  return result || '即将结束'
}

export function formatTimestamp(tsMs) {
  if (!tsMs) return '--:--'
  return moment(tsMs).tz(TIMEZONE).format('HH:mm')
}

/**
 * 根据 expireTimestamp 判断商品属于哪一轮
 * expireTimestamp 是商品过期时间（即该轮次结束时间）
 * 12:00过期 → 第1轮(08:00-12:00), 16:00过期 → 第2轮(12:00-16:00)
 * 20:00过期 → 第3轮(16:00-20:00), 00:00过期 → 第4轮(20:00-00:00)
 * @param {number} expireTimestampMs - 过期时间戳（毫秒）
 * @returns {number} 轮次编号 1-4，0 表示无法判断
 */
export function getRoundByExpireTime(expireTimestampMs) {
  if (!expireTimestampMs) return 0
  const expireTime = moment(expireTimestampMs).tz(TIMEZONE)
  const hour = expireTime.hour()
  const minute = expireTime.minute()

  // expireTimestamp 是轮次结束时间
  if (hour === 12 && minute === 0) return 1  // 08:00-12:00 第1轮
  if (hour === 16 && minute === 0) return 2  // 12:00-16:00 第2轮
  if (hour === 20 && minute === 0) return 3  // 16:00-20:00 第3轮
  if (hour === 0 && minute === 0) return 4   // 20:00-00:00 第4轮

  // 兜底：根据时间范围判断
  if (hour >= 0 && hour < 8) return 4   // 闭市时段，归入第4轮
  if (hour >= 8 && hour < 12) return 1
  if (hour >= 12 && hour < 16) return 2
  if (hour >= 16 && hour < 20) return 3
  if (hour >= 20) return 4

  return 0
}

export function shouldDetectNow() {
  const info = getRoundInfo()
  return info.status === 'active'
}

export function getNextDetectionTime() {
  const now = getBeijingTime()
  const todayStart = now.clone().startOf('day')
  const REFRESH_TIMES = getRefreshTimes()
  const DETECTION_DELAY_MINUTES = getDetectionDelayMinutes()

  for (const timeStr of REFRESH_TIMES) {
    const [hour, minute] = timeStr.split(':').map(Number)
    const detectionTime = todayStart.clone()
      .hour(hour)
      .minute(minute)
      .add(DETECTION_DELAY_MINUTES, 'minutes')
      .second(0)

    if (detectionTime.isAfter(now)) {
      return detectionTime
    }
  }

  const [firstHour, firstMinute] = REFRESH_TIMES[0].split(':').map(Number)
  return todayStart.clone().add(1, 'day')
    .hour(firstHour)
    .minute(firstMinute)
    .add(DETECTION_DELAY_MINUTES, 'minutes')
    .second(0)
}
