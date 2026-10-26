import { Hono } from "hono"
import type { RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

interface CardCountResult {
	cards: number
	level: number
}

const OngekiModsRoutes = new Hono()
	.post(
		"unlockcards",
		validateJson(
			z.object({
				version: z.number().min(1)
			})
		),
		async c => {
			const conn = await db.getConnection()
			try {
				await conn.beginTransaction()

				const userId = c.payload.userId
				const { version } = c.req.valid("json")

				await conn.execute(
					`
						INSERT INTO ongeki_user_card
							(user, cardId, digitalStock, analogStock, level, maxLevel, exp, printCount, useCount, isNew, kaikaDate, choKaikaDate, skillId, isAcquired, created)
						SELECT
							?, c.cardId, 5, 0, 70, 70, 0, 0, 0, 0, "2021-01-01 00:00:00.0", "2021-01-01 00:00:00.0", c.choKaikaSkillId, 1, "2021-01-01 00:00:00.0"
						FROM ongeki_static_cards AS c
						WHERE c.version <= ?
						ON DUPLICATE KEY UPDATE
							digitalStock = 5,
							level = 70,
							maxLevel = 70,
							kaikaDate = GREATEST("2021-01-01 00:00:00.0", kaikaDate),
							choKaikaDate = GREATEST("2021-01-01 00:00:00.0", choKaikaDate),
							skillId = c.choKaikaSkillId,
							isAcquired = 1,
							created = GREATEST("2021-01-01 00:00:00.0", created)
				`,
					[userId, version]
				)

				await conn.execute(
					`
						UPDATE ongeki_user_card uc
						INNER JOIN ongeki_static_cards sc ON uc.cardId = sc.cardId
						SET
							digitalStock = 11,
							level = 100,
							maxLevel = 100
						WHERE uc.user = ? AND sc.rarity = 0
					`,
					[userId]
				)

				const [result] = await conn.execute<(CardCountResult & RowDataPacket)[]>(
					`
					SELECT COUNT(id) AS cards, level
					FROM ongeki_user_card
					WHERE user = ?
					GROUP BY level
				`,
					[userId]
				)

				await conn.commit()

				// Return the card count result as JSON, but with a success status code
				return c.json({ result })
			} catch (error) {
				await conn.rollback()
				throw rethrowWithMessage("Failed to unlock Ongeki cards", error)
			} finally {
				conn.release()
			}
		}
	)

	.post(
		"unlockspecificitem",
		validateJson(
			z.object({
				itemKind: z.number(),
				version: z.number()
			})
		),
		async c => {
			try {
				const userId = c.payload.userId
				const { itemKind, version } = c.req.valid("json")

				await db.execute(
					`
					INSERT IGNORE INTO ongeki_user_item
						(user, itemKind, itemId, stock, isValid)
					SELECT
						?, itemKind, itemId, 1, 1
					FROM ongeki_static_rewards
					WHERE version = ? AND itemKind = ?
				`,
					[userId, version, itemKind]
				)

				return new Response()
			} catch (error) {
				throw rethrowWithMessage("Failed to unlock specific Ongeki item", error)
			}
		}
	)

	.post("unlockallitems", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.ongeki_version

			const itemKinds = [2, 3, 17, 19]
			for (const itemKind of itemKinds) {
				await db.execute(
					`
						INSERT IGNORE INTO ongeki_user_item
							(user, itemKind, itemId, stock, isValid)
						SELECT
							?, itemKind, itemId, 1, 1
						FROM ongeki_static_rewards
						WHERE version = ? AND itemKind = ?
				`,
					[userId, version, itemKind]
				)
			}
			return new Response()
		} catch (error) {
			throw rethrowWithMessage("Failed to unlock all Ongeki items", error)
		}
	})

export { OngekiModsRoutes }
