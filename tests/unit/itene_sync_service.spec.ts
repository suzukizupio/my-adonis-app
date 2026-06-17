import type IteneClient from '#services/itene_client'
import IteneSyncService from '#services/itene_sync_service'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

test.group('ITENE sync service', (group) => {
  group.setup(() => testUtils.db().migrate())
  group.each.setup(async () => {
    await db.from('itene_construction_holidays').delete()
    await db.from('itene_room_work_slots').delete()
    await db.from('itene_reservations').delete()
    await db.from('itene_construction_rooms').delete()
    await db.from('itene_constructions').delete()
  })

  test('dry-run construction sync does not write records', async ({ assert }) => {
    const service = new IteneSyncService(
      fakeClient({
        constructions: [
          {
            id: 5006,
            code: '35254447320',
            name: '共用部工事',
          },
        ],
      })
    )

    const result = await service.syncConstructions({ dryRun: true })
    const row = await db.from('itene_constructions').count('* as total').first()

    assert.equal(result.constructions, 1)
    assert.equal(Number(row?.total ?? 0), 0)
  })

  test('reservation sync upserts normalized room, reservation, and slot data', async ({
    assert,
  }) => {
    const service = new IteneSyncService(
      fakeClient({
        reservationDetail: {
          id: 5006,
          code: '35254447320',
          name: '共用部工事',
          buildingName: 'テストマンション',
          ConstructionRooms: [
            {
              id: 9001,
              constructionId: 5006,
              constructionCode: '35254447320',
              buildingId: 77,
              floorNo: 1,
              roomNo: '101',
              status: 100,
              name: '保存しない名前',
              email: 'private@example.com',
              passcode: '123456',
              Reservations: [
                {
                  id: 7001,
                  constructionId: 5006,
                  constructionRoomId: 9001,
                  roomNo: '101',
                  startAt: '2026-06-20T09:00:00+09:00',
                  endAt: '2026-06-20T10:00:00+09:00',
                  status: 100,
                  additionalFlag: false,
                  lockRoomOwner: true,
                },
              ],
            },
          ],
        },
      })
    )

    await service.syncReservations({ constructionId: 5006 })
    await service.syncReservations({ constructionId: 5006 })

    const constructionCount = await countRows('itene_constructions')
    const roomCount = await countRows('itene_construction_rooms')
    const reservationCount = await countRows('itene_reservations')
    const slotCount = await countRows('itene_room_work_slots')
    const room = await db.from('itene_construction_rooms').firstOrFail()

    assert.equal(constructionCount, 1)
    assert.equal(roomCount, 1)
    assert.equal(reservationCount, 1)
    assert.equal(slotCount, 1)
    assert.notInclude(room.raw, 'private@example.com')
    assert.notInclude(room.raw, '123456')
  })

  test('reservation sync stores construction holidays and preserves them on holiday fetch failure', async ({
    assert,
  }) => {
    const service = new IteneSyncService(
      fakeClient({
        reservationDetail: {
          id: 5006,
          code: '35254447320',
          name: '共用部工事',
          ConstructionRooms: [],
        },
        holidays: [
          {
            id: 13465,
            constructionId: 5006,
            name: '休工',
            startAt: '2026-05-28T00:45:00.000Z',
            endAt: '2026-05-28T01:30:00.000Z',
            occupancyCount: 1,
          },
        ],
      })
    )

    await service.syncReservations({ constructionId: 5006 })

    const row = await db.from('itene_construction_holidays').firstOrFail()

    assert.equal(row.itene_holiday_id, 13465)
    assert.equal(row.name, '休工')
    assert.equal(row.start_at, '2026-05-28 00:45:00')
    assert.equal(row.end_at, '2026-05-28 01:30:00')
    assert.equal(row.occupancy_count, 1)

    const failingService = new IteneSyncService(
      fakeClient({
        reservationDetail: {
          id: 5006,
          code: '35254447320',
          name: '共用部工事',
          ConstructionRooms: [],
        },
        holidayError: new Error('holiday endpoint failed'),
      })
    )

    await failingService.syncReservations({ constructionId: 5006 })

    assert.equal(await countRows('itene_construction_holidays'), 1)
  })

  test('reservation dry-run reads rooms from nested Construction payloads', async ({ assert }) => {
    const service = new IteneSyncService(
      fakeClient({
        reservationDetail: {
          Construction: {
            id: 5006,
            code: '35254447320',
            name: 'Sample construction',
            ConstructionRooms: [
              {
                id: 9001,
                roomNo: '101',
                Reservations: [{ id: 7001 }, { id: 7002 }],
              },
            ],
          },
        },
      })
    )

    const result = await service.syncReservations({ constructionId: 5006, dryRun: true })

    assert.deepEqual(result, {
      constructions: 1,
      rooms: 1,
      reservations: 2,
      workSlots: 2,
    })
  })

  test('reservation dry-run groups timetable reservations by room', async ({ assert }) => {
    const service = new IteneSyncService(
      fakeClient({
        reservationDetail: [
          {
            id: 7001,
            constructionId: 5006,
            constructionRoomId: 9001,
            floorNo: 1,
            roomNo: '101',
            lock4RoomOwner: true,
          },
          {
            id: 7002,
            constructionId: 5006,
            constructionRoomId: 9001,
            floorNo: 1,
            roomNo: '101',
          },
          {
            id: 7003,
            constructionId: 5006,
            constructionRoomId: 9002,
            floorNo: 1,
            roomNo: '102',
          },
        ],
      })
    )

    const result = await service.syncReservations({ constructionId: 5006, dryRun: true })

    assert.deepEqual(result, {
      constructions: 1,
      rooms: 2,
      reservations: 3,
      workSlots: 3,
    })
  })

  test('reservation sync preserves existing construction details for timetable payloads', async ({
    assert,
  }) => {
    const service = new IteneSyncService(
      fakeClient({
        constructions: [{ id: 5006, code: '35254447320', name: 'Stored construction' }],
        reservationDetail: [
          {
            id: 7001,
            constructionId: 5006,
            constructionRoomId: 9001,
            roomNo: '101',
          },
        ],
      })
    )

    await service.syncConstructions()
    await service.syncReservations({ constructionId: 5006 })

    const row = await db.from('itene_constructions').where('itene_id', 5006).firstOrFail()

    assert.equal(row.code, '35254447320')
    assert.equal(row.name, 'Stored construction')
  })

  test('reservation sync stores minimal construction raw for timetable-only payloads', async ({
    assert,
  }) => {
    const service = new IteneSyncService(
      fakeClient({
        reservationDetail: [
          {
            id: 7001,
            constructionId: 5006,
            constructionRoomId: 9001,
            roomNo: '101',
          },
        ],
      })
    )

    await service.syncReservations({ constructionId: 5006 })

    const row = await db.from('itene_constructions').where('itene_id', 5006).firstOrFail()

    assert.equal(row.raw, '{"id":5006}')
  })

  test('reservation sync stores timetable construction metadata when provided', async ({
    assert,
  }) => {
    const service = new IteneSyncService(
      fakeClient({
        reservationDetail: {
          id: 5006,
          name: 'Timetable construction',
          wholePeriodStartOn: '2026-06-24',
          TimetableReservations: [
            {
              id: 7001,
              constructionId: 5006,
              constructionRoomId: 9001,
              roomNo: '101',
            },
          ],
        },
      })
    )

    await service.syncReservations({ constructionId: 5006 })

    const row = await db.from('itene_constructions').where('itene_id', 5006).firstOrFail()
    const roomCount = await countRows('itene_construction_rooms')

    assert.equal(row.name, 'Timetable construction')
    assert.equal(row.whole_period_start_on, '2026-06-24')
    assert.equal(roomCount, 1)
  })

  test('reservation sync prefers dwelling details with rooms that have no reservation', async ({
    assert,
  }) => {
    const service = new IteneSyncService(
      fakeClient({
        reservationDetail: [
          {
            id: 7001,
            constructionId: 5006,
            constructionRoomId: 9001,
            roomNo: '101',
          },
        ],
        dwellingDetail: {
          id: 5006,
          name: 'Dwelling construction',
          ConstructionRooms: [
            {
              id: 9001,
              floorNo: 1,
              roomNo: '101',
              Reservations: [
                {
                  id: 7001,
                  constructionRoomId: 9001,
                  roomNo: '101',
                },
              ],
            },
            {
              id: 9002,
              floorNo: 1,
              roomNo: '102',
              Reservations: [],
            },
          ],
        },
      })
    )

    await service.syncReservations({ constructionId: 5006 })

    const rooms = await db.from('itene_construction_rooms').orderBy('room_no')

    assert.equal(rooms.length, 2)
    assert.equal(rooms[0].has_reservation, 1)
    assert.equal(rooms[1].has_reservation, 0)
    assert.equal(await countRows('itene_reservations'), 1)
  })

  test('reservation sync removes reservations no longer returned by ITENE', async ({ assert }) => {
    const service = new IteneSyncService(
      fakeClientSequence([
        {
          id: 5006,
          name: 'Sample construction',
          ConstructionRooms: [
            {
              id: 9001,
              roomNo: '101',
              Reservations: [
                {
                  id: 7001,
                  constructionRoomId: 9001,
                  roomNo: '101',
                  startAt: '2026-06-20T09:00:00+09:00',
                  endAt: '2026-06-20T10:00:00+09:00',
                },
              ],
            },
          ],
        },
        {
          id: 5006,
          name: 'Sample construction',
          ConstructionRooms: [
            {
              id: 9001,
              roomNo: '101',
              Reservations: [],
            },
          ],
        },
      ])
    )

    await service.syncReservations({ constructionId: 5006 })

    assert.equal(await countRows('itene_reservations'), 1)
    assert.equal(await countRows('itene_room_work_slots'), 1)

    await service.syncReservations({ constructionId: 5006 })

    const room = await db.from('itene_construction_rooms').firstOrFail()

    assert.equal(await countRows('itene_reservations'), 0)
    assert.equal(await countRows('itene_room_work_slots'), 0)
    assert.equal(Boolean(room.has_reservation), false)
  })
})

function fakeClient(payload: {
  constructions?: unknown[]
  reservationDetail?: unknown
  dwellingDetail?: unknown
  holidays?: unknown
  holidayError?: Error
}) {
  const client: Record<string, unknown> = {
    fetchAllConstructions: async () => payload.constructions ?? [],
    fetchReservationDetail: async () => payload.reservationDetail ?? {},
    fetchDwellingDetail: payload.dwellingDetail
      ? async () => payload.dwellingDetail
      : async () => {
          throw new Error('Dwelling detail is not available')
        },
  }

  if (payload.holidays !== undefined || payload.holidayError) {
    client.fetchHolidays = async () => {
      if (payload.holidayError) {
        throw payload.holidayError
      }

      return payload.holidays
    }
  }

  return client as unknown as IteneClient
}

function fakeClientSequence(reservationDetails: unknown[]) {
  let index = 0

  return {
    fetchAllConstructions: async () => [],
    fetchReservationDetail: async () => {
      const value = reservationDetails[Math.min(index, reservationDetails.length - 1)]
      index += 1
      return value
    },
  } as unknown as IteneClient
}

async function countRows(table: string) {
  const row = await db.from(table).count('* as total').first()
  return Number(row?.total ?? 0)
}
