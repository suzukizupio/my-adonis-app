import db from '@adonisjs/lucid/services/db'
import { ensureRecentIteneData } from '#services/itene_auto_sync_service'
import type { HttpContext } from '@adonisjs/core/http'

export default class IteneDashboardController {
  async index({ request, view }: HttpContext) {
    const syncStatus = await ensureRecentIteneData({ scope: 'constructions' })
    const statusFilter = resolveStatusFilter(request.input('status'))
    const [statusCounts, roomCount, reservationCount, workSlotCount] = await Promise.all([
      countConstructionsByStatus(),
      countRows('itene_construction_rooms'),
      countRows('itene_reservations'),
      countRows('itene_room_work_slots'),
    ])
    const filteredCount = statusCounts.byStatus[statusFilter] ?? 0
    const pagination = resolvePagination(request.input('page'), filteredCount, 50)

    const constructions = (
      await db
        .from('itene_constructions')
        .select(
          'id',
          'itene_id',
          'code',
          'name',
          'building_name',
          'status',
          'whole_period_start_on',
          'whole_period_end_on',
          'last_synced_at'
        )
        .where('status', statusFilter)
        .orderBy('last_synced_at', 'desc')
        .offset((pagination.currentPage - 1) * pagination.perPage)
        .limit(pagination.perPage)
    ).map((row) => ({
      ...withSyncedAtDisplay(row),
      status_display: describeConstructionStatus(row.status),
    }))

    return view.render('pages/dashboard', {
      metrics: {
        constructionCount: statusCounts.total,
        roomCount,
        reservationCount,
        workSlotCount,
      },
      constructions,
      pagination,
      syncStatus,
      statusFilter,
      statusTabs: buildStatusTabs(statusFilter, statusCounts),
    })
  }

  async show({ params, response, view }: HttpContext) {
    const storedConstruction = await db
      .from('itene_constructions')
      .select('id', 'itene_id')
      .where('id', params.id)
      .first()

    const syncStatus = storedConstruction
      ? await ensureRecentIteneData({ constructionId: storedConstruction.itene_id })
      : undefined

    const construction = await db
      .from('itene_constructions')
      .select(
        'id',
        'itene_id',
        'code',
        'name',
        'building_name',
        'building_id',
        'building_household',
        'building_complete_on_date',
        'reservation_acceptance_period_start_on',
        'reservation_acceptance_period_end_on',
        'whole_period_start_on',
        'whole_period_end_on',
        'residential_period_start_on',
        'residential_period_end_on',
        'status',
        'work_start_time',
        'work_end_time',
        'break_start_time',
        'break_end_time',
        'message_to_resident',
        'last_synced_at'
      )
      .where('id', params.id)
      .first()

    if (!construction) {
      response.status(404)
      return view.render('pages/errors/not_found')
    }

    const [roomCount, reservationCount, workSlotCount] = await Promise.all([
      countRowsFor('itene_construction_rooms', 'itene_construction_id', construction.id),
      countJoinedReservations(construction.id),
      countJoinedWorkSlots(construction.id),
    ])

    const roomRows = await db
      .from('itene_construction_rooms')
      .select(
        'id',
        'room_no',
        'floor_no',
        'has_reservation',
        'has_message',
        'has_remarks',
        'has_additional_flag',
        'has_option',
        'option_items',
        'option_paid',
        'last_synced_at'
      )
      .where('itene_construction_id', construction.id)
      // 部屋番号を数値として昇順（若番順）に並べる。文字列順だと 1001 が 203 より先に来てしまう。
      // ラウンジ等の番号でない部屋は末尾にまとめる
      .orderByRaw("CASE WHEN room_no GLOB '[0-9]*' THEN 0 ELSE 1 END, CAST(room_no AS INTEGER), room_no")

    // 部屋ごとの「予約を入力した日時」。居住者が予約を確定した最新の reservation_date を採用する。
    // itene_created_at はレコードの一括生成日時で予約入力とは無関係のため使わない。
    const reservationDateRows = await db
      .from('itene_reservations')
      .join(
        'itene_construction_rooms',
        'itene_reservations.itene_construction_room_id',
        'itene_construction_rooms.id'
      )
      .where('itene_construction_rooms.itene_construction_id', construction.id)
      .groupBy('itene_reservations.itene_construction_room_id')
      .select('itene_reservations.itene_construction_room_id as room_id')
      .max('itene_reservations.reservation_date as reservation_date')
    const reservationDateByRoomId = new Map<number, unknown>(
      reservationDateRows.map((row) => [Number(row.room_id), row.reservation_date])
    )

    const rooms = roomRows.map((room) => ({
      ...withSyncedAtDisplay(room),
      reservation_entered_at_display: formatJstTimestamp(reservationDateByRoomId.get(room.id)),
    }))

    const reservations = await db
      .from('itene_reservations')
      .join(
        'itene_construction_rooms',
        'itene_reservations.itene_construction_room_id',
        'itene_construction_rooms.id'
      )
      .select(
        'itene_reservations.itene_construction_room_id',
        'itene_reservations.room_no',
        'itene_reservations.floor_no',
        'itene_reservations.status',
        'itene_reservations.start_at',
        'itene_reservations.end_at',
        'itene_reservations.reservation_date',
        'itene_reservations.additional_flag',
        'itene_reservations.lock_room_owner',
        'itene_reservations.main_charge',
        'itene_reservations.sub_charge'
      )
      .where('itene_construction_rooms.itene_construction_id', construction.id)
      .orderBy('itene_reservations.start_at')

    // 部屋(ローカルID) => オプション情報。予約ブロックにマークを出すために使う
    const roomOptionByRoomId = new Map(
      rooms.map((room) => [
        room.id,
        {
          hasOption: Boolean(room.has_option),
          items: (room.option_items as string | null) ?? null,
          paid: Boolean(room.option_paid),
        },
      ])
    )

    const reservationItems = reservations.map((row) =>
      formatReservationItem(row, roomOptionByRoomId.get(row.itene_construction_room_id))
    )

    const reservationTimetable = buildReservationTimetable(reservationItems, {
      startOn: construction.whole_period_start_on,
      endOn: construction.whole_period_end_on,
      breakStartTime: construction.break_start_time,
    })

    return view.render('pages/construction_detail', {
      construction: {
        ...withSyncedAtDisplay(construction),
        status_display: describeConstructionStatus(construction.status),
      },
      metrics: {
        roomCount,
        reservationCount,
        workSlotCount,
      },
      rooms,
      reservations: reservationItems,
      reservationTimetable,
      timetableColspan: reservationTimetable.dates.length + 1,
      syncStatus,
    })
  }
}

function resolvePagination(rawPage: unknown, total: number, perPage: number) {
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const parsed = Number.parseInt(String(rawPage ?? '1'), 10)
  const currentPage = Math.min(Math.max(Number.isNaN(parsed) ? 1 : parsed, 1), totalPages)

  const windowSize = 5
  const windowEnd = Math.min(totalPages, Math.max(1, currentPage - 2) + windowSize - 1)
  const windowStart = Math.max(1, windowEnd - windowSize + 1)

  const pages: number[] = []
  for (let page = windowStart; page <= windowEnd; page += 1) {
    pages.push(page)
  }

  return {
    currentPage,
    perPage,
    totalPages,
    total,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    prevPage: Math.max(1, currentPage - 1),
    nextPage: Math.min(totalPages, currentPage + 1),
    from: total === 0 ? 0 : (currentPage - 1) * perPage + 1,
    to: Math.min(currentPage * perPage, total),
    pages,
  }
}

async function countRows(table: string) {
  const row = await db.from(table).count('* as total').first()
  return Number(row?.total ?? 0)
}

async function countRowsFor(table: string, column: string, value: number) {
  const row = await db.from(table).where(column, value).count('* as total').first()
  return Number(row?.total ?? 0)
}

async function countJoinedReservations(constructionId: number) {
  const row = await db
    .from('itene_reservations')
    .join(
      'itene_construction_rooms',
      'itene_reservations.itene_construction_room_id',
      'itene_construction_rooms.id'
    )
    .where('itene_construction_rooms.itene_construction_id', constructionId)
    .count('* as total')
    .first()

  return Number(row?.total ?? 0)
}

async function countJoinedWorkSlots(constructionId: number) {
  const row = await db
    .from('itene_room_work_slots')
    .join(
      'itene_construction_rooms',
      'itene_room_work_slots.itene_construction_room_id',
      'itene_construction_rooms.id'
    )
    .where('itene_construction_rooms.itene_construction_id', constructionId)
    .count('* as total')
    .first()

  return Number(row?.total ?? 0)
}

type ReservationItem = {
  roomNo: string
  floorNo?: number
  status?: string
  startAt?: string
  endAt?: string
  dateKey: string
  dateLabel: string
  startTime: string
  endTime: string
  timeRange: string
  additionalFlag: boolean
  lockRoomOwner: boolean
  mainCharge?: string
  subCharge?: string
  hasOption: boolean
  optionItems?: string | null
  optionPaid: boolean
}

function formatReservationItem(
  row: Record<string, any>,
  option?: { hasOption: boolean; items: string | null; paid: boolean }
): ReservationItem {
  const start = formatJstDateTime(row.start_at)
  const end = formatJstDateTime(row.end_at)
  const roomNo = row.room_no ? `${row.room_no}号室` : '-'

  return {
    roomNo,
    floorNo: row.floor_no,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    dateKey: start.dateKey,
    dateLabel: start.dateLabel,
    startTime: start.time,
    endTime: end.time,
    timeRange: `${start.time} - ${end.time}`,
    additionalFlag: Boolean(row.additional_flag),
    lockRoomOwner: Boolean(row.lock_room_owner),
    mainCharge: row.main_charge,
    subCharge: row.sub_charge,
    hasOption: Boolean(option?.hasOption),
    optionItems: option?.items ?? null,
    optionPaid: Boolean(option?.paid),
  }
}

function buildReservationTimetable(
  items: ReservationItem[],
  options: { startOn?: unknown; endOn?: unknown; breakStartTime?: unknown } = {}
) {
  const dates = buildTimetableDates(items, options.startOn, options.endOn)
  const slotKeys = Array.from(
    new Set(items.map((item) => `${item.startTime}|${item.endTime}`))
  ).sort()
  // 昼休憩の開始時刻を午前／午後の境界とする（取得できなければ正午）
  const breakStart = normalizeTimeOfDay(options.breakStartTime) ?? '12:00'
  const slots = slotKeys.map((slotKey) => {
    const [startTime, endTime] = slotKey.split('|')

    return {
      timeRange: `${startTime} - ${endTime}`,
      isAfternoon: startTime >= breakStart,
      isAfternoonStart: false,
      cells: dates.map((date) => ({
        dateKey: date.dateKey,
        reservations: items
          .filter(
            (item) =>
              item.dateKey === date.dateKey &&
              item.startTime === startTime &&
              item.endTime === endTime
          )
          .sort(compareReservations),
      })),
    }
  })

  // 午前から午後へ切り替わる最初の行に境界フラグを立てる
  slots.forEach((slot, index) => {
    slot.isAfternoonStart = index > 0 && slot.isAfternoon && !slots[index - 1].isAfternoon
  })

  return { dates, slots }
}

// 工事期間の全日付（予約のない日も含む）を日付軸として組み立てる。
// 念のため予約のある日付も和集合に加え、期間外の予約も取りこぼさないようにする
function buildTimetableDates(items: ReservationItem[], startOn: unknown, endOn: unknown) {
  const labelByDate = new Map<string, string>()

  for (const period of enumerateDates(startOn, endOn)) {
    labelByDate.set(period.dateKey, period.dateLabel)
  }
  for (const item of items) {
    if (!labelByDate.has(item.dateKey)) {
      labelByDate.set(item.dateKey, item.dateLabel)
    }
  }

  return Array.from(labelByDate.entries())
    .map(([dateKey, dateLabel]) => ({ dateKey, dateLabel }))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey))
}

function enumerateDates(startOn: unknown, endOn: unknown) {
  const start = parseDateOnly(startOn)
  const end = parseDateOnly(endOn)
  if (!start || !end || end.getTime() < start.getTime()) {
    return [] as { dateKey: string; dateLabel: string }[]
  }

  const result: { dateKey: string; dateLabel: string }[] = []
  const cursor = new Date(start)
  // 異常に長い期間の誤データでも暴走しないようガードを入れる
  for (let guard = 0; cursor.getTime() <= end.getTime() && guard < 800; guard += 1) {
    result.push(formatDateOnly(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return result
}

function parseDateOnly(value: unknown) {
  const match = String(value ?? '')
    .slice(0, 10)
    .match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return null
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

function formatDateOnly(date: Date) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value
      return result
    }, {})

  const dateKey = `${parts.year}-${parts.month}-${parts.day}`

  return {
    dateKey,
    dateLabel: `${dateKey} (${parts.weekday})`,
  }
}

function normalizeTimeOfDay(value: unknown) {
  const match = String(value ?? '').match(/^(\d{2}):(\d{2})/)
  return match ? `${match[1]}:${match[2]}` : null
}

function compareReservations(left: ReservationItem, right: ReservationItem) {
  return (
    left.startTime.localeCompare(right.startTime) ||
    left.endTime.localeCompare(right.endTime) ||
    left.roomNo.localeCompare(right.roomNo, 'ja')
  )
}

const CONSTRUCTION_STATUS_LABELS: Record<string, { label: string; variant: string }> = {
  '0': { label: '未対応', variant: 'pending' },
  '1': { label: '対応中', variant: 'progress' },
  '2': { label: '対応済み', variant: 'done' },
}

function describeConstructionStatus(status: unknown) {
  const key = status === null || status === undefined ? '' : String(status).trim()
  return CONSTRUCTION_STATUS_LABELS[key] ?? { label: key || '未設定', variant: 'unknown' }
}

// タブの表示順。既定（対応中）を先頭に置く
const CONSTRUCTION_STATUS_FILTERS = ['1', '0', '2'] as const
const DEFAULT_CONSTRUCTION_STATUS_FILTER = '1'

function resolveStatusFilter(raw: unknown) {
  const value = raw === null || raw === undefined ? '' : String(raw).trim()
  return (CONSTRUCTION_STATUS_FILTERS as readonly string[]).includes(value)
    ? value
    : DEFAULT_CONSTRUCTION_STATUS_FILTER
}

async function countConstructionsByStatus() {
  const rows = await db
    .from('itene_constructions')
    .select('status')
    .count('* as total')
    .groupBy('status')

  const byStatus: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    const key = row.status === null || row.status === undefined ? '' : String(row.status).trim()
    const count = Number(row.total ?? 0)
    byStatus[key] = (byStatus[key] ?? 0) + count
    total += count
  }

  return { byStatus, total }
}

function buildStatusTabs(activeStatus: string, statusCounts: { byStatus: Record<string, number> }) {
  return CONSTRUCTION_STATUS_FILTERS.map((status) => {
    const info = describeConstructionStatus(status)
    return {
      status,
      label: info.label,
      variant: info.variant,
      count: statusCounts.byStatus[status] ?? 0,
      isActive: status === activeStatus,
    }
  })
}

function withSyncedAtDisplay<T extends { last_synced_at?: unknown }>(record: T) {
  return {
    ...record,
    last_synced_at_display: formatJstTimestamp(record.last_synced_at),
  }
}

function formatJstTimestamp(value: unknown) {
  const dateTime = formatJstDateTime(value)

  if (dateTime.dateKey === '-') {
    return '-'
  }

  return `${dateTime.dateKey} ${dateTime.time}`
}

function formatJstDateTime(value: unknown) {
  if (!value) {
    return {
      dateKey: '-',
      dateLabel: '-',
      time: '-',
    }
  }

  const date = parseStoredDateTime(value)
  if (Number.isNaN(date.getTime())) {
    return {
      dateKey: '-',
      dateLabel: '-',
      time: '-',
    }
  }

  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value
      return result
    }, {})

  const dateKey = `${parts.year}-${parts.month}-${parts.day}`

  return {
    dateKey,
    dateLabel: `${dateKey} (${parts.weekday})`,
    time: `${parts.hour}:${parts.minute}`,
  }
}

function parseStoredDateTime(value: unknown) {
  if (value instanceof Date) {
    return value
  }

  const text = String(value).trim()
  const normalized = text.replace(' ', 'T')
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalized)

  return new Date(hasTimeZone ? normalized : `${normalized}Z`)
}
