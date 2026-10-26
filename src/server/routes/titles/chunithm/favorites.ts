import { Hono } from "hono"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"
import { DB } from "@/app/shared/types"

const FavoritesRoutes = new Hono()

	.post(
		"add",
		validateJson(
			z.object({
				user: z.number(),
				version: z.number(),
				favId: z.number(),
				favKind: z.number()
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const { favId } = c.req.valid("json")

				const version = versions.chunithm_version

				const [insert] = await db.execute<ResultSetHeader>(
					`INSERT INTO chuni_item_favorite (user, version, favId, favKind)
       		 VALUES (?, ?, ?, 1)`,
					[userId, version, favId]
				)

				return c.json(insert)
			} catch (error) {
				throw rethrowWithMessage("Failed to add favorite", error)
			}
		}
	)

	.post(
		"remove",
		validateJson(
			z.object({
				user: z.number(),
				version: z.number(),
				favId: z.number(),
				favKind: z.number()
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const { favId } = c.req.valid("json")

				const version = versions.chunithm_version

				const [result] = await db.execute<ResultSetHeader>(
					`DELETE FROM chuni_item_favorite
       		 WHERE user = ? AND version = ? AND favId = ? AND favKind = 1`,
					[userId, version, favId]
				)

				return c.json(result)
			} catch (error) {
				throw rethrowWithMessage("Failed to remove favorite", error)
			}
		}
	)

	.get("all", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.chunithm_version

			const [results] = await db.execute<(DB.ChuniItemFavorite & RowDataPacket)[]>(
				`SELECT favId FROM chuni_item_favorite
         WHERE user = ? AND version = ? AND favKind = 1`,
				[userId, version]
			)

			return c.json(results)
		} catch (error) {
			throw rethrowWithMessage("Failed to get favorites", error)
		}
	})

export { FavoritesRoutes }
