import { Hono } from "hono"
import type { ResultSetHeader } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

const UsernameRoutes = new Hono().post(
	"update",
	validateJson(
		z.object({
			userName: z.string().trim().min(1).max(32)
		})
	),
	async c => {
		try {
			const { userId, versions } = c.payload
			const { userName } = c.req.valid("json")
			const version = versions.ongeki_version

			const [update] = await db.execute<ResultSetHeader>(
				`
           UPDATE ongeki_profile_data
           SET userName = ?
           WHERE user = ?
           AND version = ?`,
				[userName, userId, version]
			)

			return c.json(update)
		} catch (error) {
			throw rethrowWithMessage("Failed to update username", error)
		}
	}
)

export { UsernameRoutes }
