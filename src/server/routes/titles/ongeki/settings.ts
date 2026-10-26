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

interface VersionResponse {
	version: string
}

interface VersionsResponse {
	versions: number[]
}

interface VersionResult {
	value: string
}

interface VersionEntry {
	version: number
}

const OngekiSettingsRoutes = new Hono()

	.get("get", async (c): Promise<Response> => {
		try {
			const userId = c.payload.userId

			const [results] = await db.execute<(VersionResult & RowDataPacket)[]>(
				`SELECT value
       FROM cozynet_user_option
       WHERE user = ? AND \`key\` = 'ongeki_version'`,
				[userId]
			)

			return c.json({
				version: results[0]?.value ?? "No version"
			} as VersionResponse)
		} catch (error) {
			throw rethrowWithMessage("Failed to get Ongeki version", error)
		}
	})
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
        WHERE user = ? AND \`key\` = '${DaphnisUserOptionKey.OngekiVersion}'
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
	.get("versions", async (c): Promise<Response> => {
		try {
			const userId = c.payload.userId

			const [versions] = await db.execute<(VersionEntry & RowDataPacket)[]>(
				`SELECT DISTINCT version
       FROM ongeki_profile_data
       WHERE user = ?
       ORDER BY version DESC`,
				[userId]
			)

			return c.json({
				versions: versions.map(v => v.version)
			} as VersionsResponse)
		} catch (error) {
			throw rethrowWithMessage("Failed to get Ongeki versions", error)
		}
	})

export { OngekiSettingsRoutes }
