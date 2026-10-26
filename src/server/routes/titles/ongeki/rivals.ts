import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

const OngekiRivalsRoutes = new Hono()
	.post(
		"add",
		validateJson(
			z.object({
				rivalUserId: z.number().int().positive()
			})
		),
		async c => {
			try {
				const userId = c.payload.userId
				const { rivalUserId } = c.req.valid("json")

				const [results] = await db.execute<ResultSetHeader>(
					`
						INSERT INTO ongeki_profile_rival (user, rivalUserId)
						VALUES (?, ?)
					`,
					[userId, rivalUserId]
				)
				if (results.affectedRows === 0) {
					throw new HTTPException(500, { message: "Insert failed" })
				}
				return c.json(results)
			} catch (error) {
				throw rethrowWithMessage("Failed to add rival", error)
			}
		}
	)

	.post(
		"remove",
		validateJson(
			z.object({
				rivalUserId: z.number().int().positive()
			})
		),
		async c => {
			try {
				const userId = c.payload.userId
				const { rivalUserId } = c.req.valid("json")

				const [results] = await db.execute<ResultSetHeader>(
					`
						DELETE FROM ongeki_profile_rival
         				WHERE user = ? AND rivalUserId = ?
					`,
					[userId, rivalUserId]
				)
				if (results.affectedRows === 0) {
					throw new HTTPException(500, { message: "Delete failed" })
				}
				return c.json(results)
			} catch (error) {
				throw rethrowWithMessage("Failed to remove rival", error)
			}
		}
	)

	.get("all", async c => {
		try {
			const userId = c.payload.userId

			const [results] = await db.execute<({ rivalUserId: number } & RowDataPacket)[]>(
				`
					SELECT rivalUserId
         			FROM ongeki_profile_rival
         			WHERE user = ?
				`,
				[userId]
			)

			return c.json(results.map(row => row.rivalUserId))
		} catch (error) {
			throw rethrowWithMessage("Failed to get rivals", error)
		}
	})

	.get("mutual", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.ongeki_version

			const [results] = await db.execute<({ rivalId: number; isMutual: number } & RowDataPacket)[]>(
				`
					SELECT
						r1.rivalUserId AS rivalId,
						CASE
							WHEN EXISTS (
							SELECT 1
							FROM ongeki_profile_rival AS r2
							WHERE r2.user = r1.rivalUserId
								AND r2.rivalUserId = r1.user
							) THEN 1
							ELSE 0
						END AS isMutual
					FROM ongeki_profile_rival AS r1
					WHERE r1.user = ?
						AND EXISTS (
							SELECT 1
							FROM ongeki_profile_data AS opd
							WHERE opd.user = r1.rivalUserId
								AND opd.version = ?
						)
				`,
				[userId, version]
			)

			return c.json(results)
		} catch (error) {
			throw rethrowWithMessage("Failed to get mutual rivals", error)
		}
	})

	.get("userlookup", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.ongeki_version

			const [results] = await db.execute<({ id: number; username: string } & RowDataPacket)[]>(
				`
					SELECT
          				user AS id,
          				userName AS username
         			FROM ongeki_profile_data
         			WHERE version = ?
         			AND user != ?
				`,
				[version, userId]
			)

			return c.json(results)
		} catch (error) {
			throw rethrowWithMessage("Failed to get Aime users", error)
		}
	})

	.get("count", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.ongeki_version

			const [result] = await db.execute<({ rivalCount: number } & RowDataPacket)[]>(
				`SELECT COUNT(*) AS rivalCount
         FROM ongeki_profile_rival AS opr
         WHERE opr.user = ?
         	AND EXISTS (
         		SELECT 1
         		FROM ongeki_profile_data AS opd
         		WHERE opd.user = opr.rivalUserId
         			AND opd.version = ?
         	)`,
				[userId, version]
			)

			return c.json(result[0].rivalCount)
		} catch (error) {
			throw rethrowWithMessage("Failed to get rival count", error)
		}
	})

export { OngekiRivalsRoutes }
