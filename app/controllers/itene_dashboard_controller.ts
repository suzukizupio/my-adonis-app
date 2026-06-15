import db from '@adonisjs/lucid/services/db'
import { ensureRecentIteneData } from '#services/itene_auto_sync_service'
import type { HttpContext } from '@adonisjs/core/http'

export default class IteneDashboardController {
  async index({ request, view }: HttpContext) {
    const syncStatus = await ensureRecentIteneData({ scope: 'constructions' })
    const [constructionCount, roomCount, reservationCount, workSlotCount] = await Promise.all([
      countRows('itene_constructions'),
      countRows('itene_construction_rooms'),
      countRows('itene_reservations'),
      countRows('itene_room_work_slots'),
    ])
    const pagination = resolvePagination(request.input('page'), constructionCount, 50)

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
        .orderBy('last_synced_at', 'desc')
        .offset((pagination.currentPage - 1) * pagination.perPage)
        .limit(pagination.perPage)
    ).map(withSyncedAtDisplay)

    return view.render('pages/dashboard', {
      metrics: {
        constructionCount,
        roomCount,
        reservationCount,
        workSlotCount,
      },
      constructions,
      pagination,
      syncStatus,
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

    const rooms = (
      await db
        .from('itene_construction_rooms')
        .select(
          'id',
          'room_no',
          'floor_no',
          'status',
          'has_reservation',
          'has_message',
          'has_remarks',
          'has_additional_flag',
          'last_synced_at'
        )
        .where('itene_construction_id', construction.id)
        .orderBy('room_no')
    ).map(withSyncedAtDisplay)

    const reservations = await db
      .from('itene_reservations')
      .join(
        'itene_construction_rooms',
        'itene_reservations.itene_construction_room_id',
        'itene_construction_rooms.id'
      )
      .select(
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

    const reservationItems = reservations.map(formatReservationItem)

    const reservationTimetable = buildReservationTimetable(reservationItems)

    return view.render('pages/construction_detail', {
      construction: withSyncedAtDisplay(construction),
      metrics: {
        roomCount,
        reservationCount,
        workSlotCount,
      },
      rooms,
      reservations: reservationItems,
      reservationGroups: groupReservationsByDate(reservationItems),
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
}

function formatReservationItem(row: Record<string, any>): ReservationItem {
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
  }
}

function groupReservationsByDate(items: ReservationItem[]) {
  const groups = new Map<
    string,
    { dateKey: string; dateLabel: string; reservations: ReservationItem[] }
  >()

  for (const item of items) {
    if (!groups.has(item.dateKey)) {
      groups.set(item.dateKey, {
        dateKey: item.dateKey,
        dateLabel: item.dateLabel,
        reservations: [],
      })
    }

    groups.get(item.dateKey)!.reservations.push(item)
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    reservations: group.reservations.sort(compareReservations),
  }))
}

function buildReservationTimetable(items: ReservationItem[]) {
  const dates = groupReservationsByDate(items).map((group) => ({
    dateKey: group.dateKey,
    dateLabel: group.dateLabel,
  }))
  const slotKeys = Array.from(
    new Set(items.map((item) => `${item.startTime}|${item.endTime}`))
  ).sort()
  const slots = slotKeys.map((slotKey) => {
    const [startTime, endTime] = slotKey.split('|')

    return {
      timeRange: `${startTime} - ${endTime}`,
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

  return { dates, slots }
}

function compareReservations(left: ReservationItem, right: ReservationItem) {
  return (
    left.startTime.localeCompare(right.startTime) ||
    left.endTime.localeCompare(right.endTime) ||
    left.roomNo.localeCompare(right.roomNo, 'ja')
  )
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
