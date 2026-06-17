import db from '@adonisjs/lucid/services/db'
import { ensureRecentIteneData } from '#services/itene_auto_sync_service'
import type { HttpContext } from '@adonisjs/core/http'

export default class IteneDashboardController {
  async index({ request, view }: HttpContext) {
    const syncStatus = await ensureRecentIteneData({ scope: 'constructions' })
    const statusFilter = resolveStatusFilter(request.input('status'))
    const search = resolveSearch(request.input('q'))
    const sort = resolveSort(request.input('sort'))
    const direction = resolveDirection(request.input('dir'))

    const [statusCounts, roomCount, reservationCount, workSlotCount, filteredCount] =
      await Promise.all([
        countConstructionsByStatus(),
        countRows('itene_construction_rooms'),
        countRows('itene_reservations'),
        countRows('itene_room_work_slots'),
        countConstructions(statusFilter, search),
      ])

    const pagination = resolvePagination(request.input('page'), filteredCount, 50)

    const query = db
      .from('itene_constructions')
      .select(
        'id',
        'itene_id',
        'code',
        'name',
        'building_name',
        'building_household',
        'status',
        'whole_period_start_on',
        'whole_period_end_on',
        'last_synced_at',
        'option_application_count'
      )
    applyConstructionFilters(query, statusFilter, search)

    const constructions = (
      await query
        // 既定は期間（開始日）の新しい順。SQLite は DESC で NULL を末尾に並べる
        .orderBy(SORT_COLUMNS[sort], direction)
        .orderBy('itene_id', 'desc')
        .offset((pagination.currentPage - 1) * pagination.perPage)
        .limit(pagination.perPage)
    ).map((row) => ({
      ...withSyncedAtDisplay(row),
      status_display: describeConstructionStatus(row.status),
      option_display: describeOptionApplications(row.option_application_count),
    }))

    const baseQuery = buildQuery({ status: statusFilter, q: search, sort, dir: direction })

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
      search,
      sort,
      direction,
      baseQuery,
      clearSearchHref: `?${buildQuery({ status: statusFilter, sort, dir: direction })}`,
      sortLinks: buildSortLinks(statusFilter, search, sort, direction),
      statusTabs: buildStatusTabs(statusFilter, statusCounts, search, sort, direction),
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
        'message',
        'remarks',
        'raw',
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

    const rooms = roomRows.map((room) => {
      const { raw, ...rest } = room
      return {
        ...withSyncedAtDisplay(rest),
        // message/remarks カラム導入前に同期した既存データは raw（生JSON）から本文を補完する
        message: rest.message ?? extractRoomMemo(raw, 'message'),
        remarks: rest.remarks ?? extractRoomMemo(raw, 'remarks'),
        reservation_entered_at_display: formatJstTimestamp(reservationDateByRoomId.get(room.id)),
      }
    })

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

// ソート可能な列。キー => 実カラム名
const SORT_COLUMNS = {
  period: 'whole_period_start_on',
  id: 'itene_id',
  name: 'name',
  household: 'building_household',
  option: 'option_application_count',
} as const
type SortKey = keyof typeof SORT_COLUMNS
const DEFAULT_SORT: SortKey = 'period'

function resolveSearch(raw: unknown): string {
  const value = raw === null || raw === undefined ? '' : String(raw).trim()
  return value.slice(0, 100)
}

function resolveSort(raw: unknown): SortKey {
  const value = raw === null || raw === undefined ? '' : String(raw).trim()
  return (value in SORT_COLUMNS ? value : DEFAULT_SORT) as SortKey
}

function resolveDirection(raw: unknown): 'asc' | 'desc' {
  const value = raw === null || raw === undefined ? '' : String(raw).trim().toLowerCase()
  return value === 'asc' ? 'asc' : 'desc'
}

// 状態フィルタ＋フリーワード検索（工事名・物件名・工事ID）を query builder に適用する
function applyConstructionFilters(query: ReturnType<typeof db.from>, status: string, search: string) {
  query.where('status', status)
  if (search) {
    query.where((builder: any) => {
      builder.where('name', 'like', `%${search}%`).orWhere('building_name', 'like', `%${search}%`)
      if (/^\d+$/.test(search)) {
        builder.orWhere('itene_id', Number(search))
      }
    })
  }
  return query
}

async function countConstructions(status: string, search: string): Promise<number> {
  const query = db.from('itene_constructions')
  applyConstructionFilters(query, status, search)
  const row = await query.count('* as total').first()
  return Number(row?.total ?? 0)
}

// 空値を除いたクエリ文字列を作る（ページネーション・タブ・ソートのリンク共通化）
function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') {
      usp.set(key, String(value))
    }
  }
  return usp.toString()
}

// 各列見出し用のソートリンク。クリックで desc→asc をトグルし、矢印を出す
function buildSortLinks(status: string, search: string, sort: SortKey, direction: 'asc' | 'desc') {
  const links: Record<string, { href: string; arrow: string; active: boolean }> = {}
  for (const key of Object.keys(SORT_COLUMNS) as SortKey[]) {
    const active = sort === key
    const nextDir = active && direction === 'desc' ? 'asc' : 'desc'
    links[key] = {
      href: `?${buildQuery({ status, q: search, sort: key, dir: nextDir })}`,
      arrow: active ? (direction === 'desc' ? '↓' : '↑') : '',
      active,
    }
  }
  return links
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

function buildStatusTabs(
  activeStatus: string,
  statusCounts: { byStatus: Record<string, number> },
  search: string,
  sort: SortKey,
  direction: 'asc' | 'desc'
) {
  return CONSTRUCTION_STATUS_FILTERS.map((status) => {
    const info = describeConstructionStatus(status)
    return {
      status,
      label: info.label,
      variant: info.variant,
      count: statusCounts.byStatus[status] ?? 0,
      isActive: status === activeStatus,
      // タブ切替時も検索語・並び順は維持する
      href: `?${buildQuery({ status, q: search, sort, dir: direction })}`,
    }
  })
}

// 一覧で「オプション申込を受け付けている工事か」を表示するための判定。
// null = 予約同期がまだ（未取得）、0 = 申込なし、N = N部屋で申込あり
function describeOptionApplications(count: unknown) {
  if (count === null || count === undefined) {
    return { state: 'unknown', label: '未取得', count: null as number | null }
  }

  const parsed = Number(count)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { state: 'none', label: 'なし', count: 0 }
  }

  return { state: 'has', label: `${parsed}件`, count: parsed }
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

// raw（同期時に保存した生JSON）から本文を取り出すフォールバック。
// message/remarks カラム導入前に同期した既存データでも内容を表示できるようにする
function extractRoomMemo(raw: unknown, key: 'message' | 'remarks'): string | null {
  if (typeof raw !== 'string' || raw === '') {
    return null
  }

  try {
    const value = (JSON.parse(raw) as Record<string, unknown> | null)?.[key]
    return value === undefined || value === null || value === '' ? null : String(value)
  } catch {
    return null
  }
}
