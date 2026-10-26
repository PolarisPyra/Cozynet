import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { signAndSetCookie } from "@/server/utils/cookie"
import { rethrowWithMessage } from "@/server/utils/error"
import { getUserGameVersions } from "@/server/utils/versions"
import { DB, DaphnisUserOptionKey } from "@/app/shared/types"

const MaimaiDXSettings = new Hono()
	.post(
		"update",
		validateJson(
			z.object({
				version: z.number().min(1)
			})
		),
		async c => {
			const conn = await db.getConnection()
			try {
				await conn.beginTransaction()

				const { userId, aimeCardId } = c.payload
				const { version } = c.req.valid("json")
				if (!aimeCardId) {
					throw new HTTPException(400, { message: "Missing Aime card id" })
				}

				const [result] = await conn.execute<ResultSetHeader>(
					`
						UPDATE cozynet_user_option
						SET value = ?
						WHERE user = ? AND \`key\` = '${DaphnisUserOptionKey.MaimaiDXVersion}'
					`,
					[version, userId]
				)

				if (result.affectedRows === 0) {
					throw new HTTPException(404)
				}

				// Gotta update the cookie now that the version has changed
				const [users] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>("SELECT * FROM aime_user WHERE id = ?", [
					userId
				])
				const user = users[0]
				const [cards] = await conn.execute<(DB.AimeCard & RowDataPacket)[]>(
					"SELECT * FROM aime_card WHERE access_code = ?",
					[aimeCardId]
				)
				const card = cards[0]
				if (!user || !card) {
					throw new HTTPException(404)
				}
				const versions = await getUserGameVersions(userId, conn)
				const cookieResult = await signAndSetCookie(c, user, card, versions)

				await conn.commit()
				return c.json(cookieResult)
			} catch (error) {
				await conn.rollback()
				throw rethrowWithMessage("Failed to update settings", error)
			} finally {
				conn.release()
			}
		}
	)
	.get("versions", async c => {
		try {
			const userId = c.payload.userId
			const [versions] = await db.execute<({ version: number } & RowDataPacket)[]>(
				`
					SELECT DISTINCT version
					FROM mai2_profile_detail
					WHERE user = ?
					ORDER BY version DESC
				`,
				[userId]
			)

			return c.json(versions.map(v => v.version))
		} catch (error) {
			throw rethrowWithMessage("Failed to get versions", error)
		}
	})

/**
 * Unlock endpoints
 */

export { MaimaiDXSettings }
