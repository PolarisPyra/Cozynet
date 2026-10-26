import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"
import { DB } from "@/app/shared/types"

const ChunithmTeamsRoutes = new Hono()

	.get("teams", async c => {
		try {
			const [results] = await db.execute<(DB.ChuniProfileTeam & RowDataPacket)[]>(`SELECT * FROM chuni_profile_team`)
			return c.json(results)
		} catch (error) {
			throw rethrowWithMessage("Failed to get teams", error)
		}
	})

	.post(
		"updateteam",
		validateJson(
			z.object({
				teamId: z.number()
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const { teamId } = c.req.valid("json")

				const version = versions.chunithm_version

				const [result] = await db.execute<ResultSetHeader>(
					`
                UPDATE
                chuni_profile_data
                SET teamId = ?
                WHERE user = ?
                AND version = ?`,
					[teamId, userId, version]
				)
				return c.json(result)
			} catch (error) {
				throw rethrowWithMessage("Failed to remove favorite", error)
			}
		}
	)

	.post(
		"addteam",
		validateJson(
			z.object({
				teamName: z.string().min(1)
			})
		),
		async c => {
			try {
				const { teamName } = c.req.valid("json")

				const [existingTeam] = await db.execute<RowDataPacket[]>(
					`SELECT id FROM chuni_profile_team WHERE teamName = ?`,
					[teamName]
				)

				if (existingTeam.length > 0) {
					throw new HTTPException(409, { message: "Team already exists" })
				}

				const [insert] = await db.execute<ResultSetHeader>(`INSERT INTO chuni_profile_team (teamName) VALUES (?)`, [
					teamName
				])

				return c.json(insert)
			} catch (error) {
				throw rethrowWithMessage("Failed to add team", error)
			}
		}
	)

export { ChunithmTeamsRoutes }
