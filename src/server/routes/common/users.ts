import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { DB } from "@/app/shared/types"
import { accessCodeSchema, eamuseAccessCodeSchema } from "@/app/shared/types/validation/auth"
import { type ExecutableConnection, db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

type CardTable = "aime_card" | "eamuse_card"

const bindCard = async (connection: ExecutableConnection, table: CardTable, accessCode: string, userId: number) => {
	const [cards] = await connection.execute<(Pick<DB.AimeCard, "id" | "user"> & RowDataPacket)[]>(
		`SELECT id, user FROM ${table} WHERE access_code = ?`,
		[accessCode]
	)

	const card = cards[0]
	if (card && card.user !== userId) {
		const [users] = await connection.execute<(DB.AimeUser & RowDataPacket)[]>(
			"SELECT id FROM aime_user WHERE id = ? AND (username IS NOT NULL OR password IS NOT NULL)",
			[card.user]
		)
		if (users.length > 0) throw new HTTPException(409, { message: "Card already bound to another user" })

		await connection.execute<ResultSetHeader>(`UPDATE ${table} SET user = ? WHERE id = ?`, [userId, card.id])
		return card.id
	}

	if (card) return card.id

	const [result] = await connection.execute<ResultSetHeader>(
		`INSERT INTO ${table} (user, access_code, created_date, is_locked, is_banned, memo) VALUES (?, ?, NOW(), 0, 0, '')`,
		[userId, accessCode]
	)
	return result.insertId
}

const UserRoutes = new Hono()
	.post("/verify", async c => {
		try {
			return c.json(c.payload)
		} catch (error) {
			throw rethrowWithMessage("Failed to verify user", error)
		}
	})
	// User card management routes
	.get("/cards", async c => {
		try {
			const { userId } = c.payload
			if (!userId) throw new HTTPException(403)

			const [cards] = await db.execute<(DB.UserCard & RowDataPacket)[]>(
				`SELECT id, user, access_code, idm, created_date, last_login_date, is_locked, is_banned, memo,
					'allnet' AS card_type, NULL AS is_primary
				 FROM aime_card WHERE user = ?
				 UNION ALL
				 SELECT id, user, access_code, idm, created_date, last_login_date, is_locked, is_banned, memo,
						'eamuse' AS card_type,
						EXISTS (
							SELECT 1 FROM aime_card primary_card
							WHERE primary_card.user = eamuse_card.user
							  AND primary_card.primary_eamuse_card = eamuse_card.id
						) AS is_primary
				 FROM eamuse_card WHERE user = ?
				 ORDER BY created_date ASC, id ASC`,
				[userId, userId]
			)

			return c.json({ cards })
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch user cards", error)
		}
	})
	.post(
		"/cards/bind",
		validateJson(
			z
				.object({
					accessCode: accessCodeSchema.optional(),
					eamuseAccessCode: eamuseAccessCodeSchema.optional()
				})
				.refine(value => value.accessCode || value.eamuseAccessCode, {
					message: "An ALL.NET access code or e-amusement code is required"
				})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { accessCode, eamuseAccessCode } = c.req.valid("json")

				if (!userId) throw new HTTPException(403)
				const connection = (await db.getConnection()) as ExecutableConnection
				try {
					await connection.beginTransaction()
					if (accessCode) await bindCard(connection, "aime_card", accessCode, userId)
					if (eamuseAccessCode) {
						const eamuseCardId = await bindCard(connection, "eamuse_card", eamuseAccessCode, userId)
						const [primaryCandidates] = await connection.execute<(Pick<DB.AimeCard, "id"> & RowDataPacket)[]>(
							"SELECT id FROM aime_card WHERE user = ? AND primary_eamuse_card IS NULL ORDER BY id ASC LIMIT 1",
							[userId]
						)
						if (eamuseCardId && primaryCandidates[0]) {
							await connection.execute<ResultSetHeader>(
								"UPDATE aime_card SET primary_eamuse_card = ? WHERE id = ? AND user = ? AND primary_eamuse_card IS NULL",
								[eamuseCardId, primaryCandidates[0].id, userId]
							)
						}
					}
					await connection.commit()
				} catch (error) {
					await connection.rollback()
					throw error
				} finally {
					connection.release()
				}

				return c.json({ success: true })
			} catch (error) {
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to bind card", error)
			}
		}
	)
	.post(
		"/cards/unbind",
		validateJson(
			z
				.object({
					accessCode: accessCodeSchema.optional(),
					eamuseAccessCode: eamuseAccessCodeSchema.optional()
				})
				.refine(value => value.accessCode || value.eamuseAccessCode, {
					message: "An ALL.NET access code or e-amusement code is required"
				})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { accessCode, eamuseAccessCode } = c.req.valid("json")

				if (!userId) throw new HTTPException(403)

				const table = accessCode ? "aime_card" : "eamuse_card"
				const value = accessCode || eamuseAccessCode
				const [result] = await db.execute<ResultSetHeader>(`DELETE FROM ${table} WHERE user = ? AND access_code = ? AND is_banned = 0 AND is_locked = 0`, [
					userId,
					value
				])

				if (result.affectedRows === 0)
					throw new HTTPException(404, { message: "Card not found, not bound to your account, or locked" })

				return c.json({ success: true })
			} catch (error) {
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to unbind card", error)
			}
		}
	)
export { UserRoutes }
