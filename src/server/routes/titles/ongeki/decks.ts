import { Hono } from "hono"
import type { RowDataPacket } from "mysql2"
import { z } from "zod"

import type { DB } from "@/app/shared/types"
import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

const OngekiDecksRoutes = new Hono()
	.get("/", async c => {
		try {
			const { userId } = c.payload

			const [decks] = await db.execute<(RowDataPacket & DB.OngekiUserDeck)[]>(
				"SELECT * FROM ongeki_user_deck WHERE user = ? ORDER BY deckId ASC",
				[userId]
			)

			return c.json({ decks })
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch Ongeki decks", error)
		}
	})
	.post(
		"/update",
		validateJson(
			z.object({
				deckId: z.number().int().nonnegative(),
				cardId1: z.number().int().nonnegative(),
				cardId2: z.number().int().nonnegative(),
				cardId3: z.number().int().nonnegative()
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { deckId, cardId1, cardId2, cardId3 } = c.req.valid("json")

				// Check if deck exists
				const [existing] = await db.execute<RowDataPacket[]>(
					"SELECT id FROM ongeki_user_deck WHERE user = ? AND deckId = ?",
					[userId, deckId]
				)

				if (existing.length > 0) {
					await db.execute(
						"UPDATE ongeki_user_deck SET cardId1 = ?, cardId2 = ?, cardId3 = ? WHERE user = ? AND deckId = ?",
						[cardId1, cardId2, cardId3, userId, deckId]
					)
				} else {
					await db.execute(
						"INSERT INTO ongeki_user_deck (user, deckId, cardId1, cardId2, cardId3) VALUES (?, ?, ?, ?, ?)",
						[userId, deckId, cardId1, cardId2, cardId3]
					)
				}

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to update Ongeki deck", error)
			}
		}
	)

export { OngekiDecksRoutes }
