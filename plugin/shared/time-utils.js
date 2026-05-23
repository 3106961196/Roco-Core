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
