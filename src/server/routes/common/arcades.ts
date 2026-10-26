import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { DB, UserRole } from "@/app/shared/types"
import { arcadeNameSchema, arcadeNicknameSchema } from "@/app/shared/types/validation/auth"
import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

const ArcadeRoutes = new Hono()

	.get("list", async c => {
		try {
			const { permissions } = c.payload
			if (permissions !== UserRole.Admin) {
				throw new HTTPException(403, { message: "Admin permissions required" })
			}

			const [results] = await db.execute<(DB.Machine & RowDataPacket)[]>(
				`SELECT
    m.id,
    m.arcade,
    m.serial,
    m.board,
    m.game,
    m.country,
    m.timezone,
    m.ota_enable,
    m.memo,
    m.is_cab,
    m.data,
    a.id,
    a.name,
    a.nickname,
    a.country,
    a.country_id,
    a.state,
    a.city,
    a.region_id,
    a.timezone,
    a.ip,
    ao.user,
    ao.arcade,
    ao.permissions
FROM arcade a
LEFT JOIN machine m ON a.id = m.arcade
LEFT JOIN arcade_owner ao ON a.id = ao.arcade
			`
			)
			return c.json(results)
		} catch (error) {
			throw rethrowWithMessage("Failed to get static music", error)
		}
	})
	.get("current", async c => {
		try {
			const { userId } = c.payload
			if (!userId) {
				throw new HTTPException(403)
			}

			const [results] = await db.execute<(DB.Machine & RowDataPacket)[]>(
				`SELECT m.*, a.*, ao.*
    FROM machine m
    LEFT JOIN arcade a ON m.arcade = a.id
    LEFT JOIN arcade_owner ao ON a.id = ao.arcade
  WHERE user = ?
  `,
				[userId]
			)
			return c.json(results)
		} catch (error) {
			throw rethrowWithMessage("Failed to get static music", error)
		}
	})

	.get("users", async c => {
		try {
			const { permissions } = c.payload
			if (permissions !== UserRole.Admin) {
				throw new HTTPException(403, { message: "Admin permissions required" })
			}

			const [results] = await db.execute<(DB.AimeUser & RowDataPacket)[]>(
				`SELECT au.id, au.username, au.email, au.permissions, au.created_date, au.last_login_date, au.suspend_expire_time, ac.access_code
					FROM aime_user au
					LEFT JOIN aime_card ac ON au.id = ac.user`
			)
			return c.json(results)
		} catch (error) {
			throw rethrowWithMessage("Failed to get static music", error)
		}
	})
	.post(
		"update/location",
		validateJson(
			z.object({
				arcade: z.number().int().positive(),
				country: z.string().trim().min(1).max(128),
				state: z.string().trim().min(1).max(128),
				regionId: z.number().int().nonnegative()
			})
		),
		async c => {
			try {
				const { userId, permissions } = c.payload
				const { arcade, country, state, regionId } = c.req.valid("json")

				if (!userId) {
					throw new HTTPException(403)
				}

				if (permissions !== UserRole.Admin) {
					const [ownership] = await db.execute<({ count: number } & RowDataPacket)[]>(
						"SELECT COUNT(*) as count FROM arcade_owner WHERE arcade = ? AND user = ? AND permissions = 1",
						[arcade, userId]
					)

					if (!ownership?.[0]?.count) {
						throw new HTTPException(403, {
							message: "You do not have permission to update this arcade"
						})
					}
				}

				// Update location fields in the arcade table
				const [update] = await db.execute<ResultSetHeader>(
					`UPDATE arcade
    		SET country = ?, state = ?, region_id = ?
    		WHERE id = ?`,
					[country, state, regionId, arcade]
				)

				if (update.affectedRows === 0) {
					throw new HTTPException(404, { message: "Arcade not found" })
				}

				return c.json({
					success: true,
					message: "Arcade location updated successfully"
				})
			} catch (error) {
				throw rethrowWithMessage("Failed to update arcade location", error)
			}
		}
	)
	.post(
		"update/name",
		validateJson(
			z
				.object({
					arcade: z.number().int().positive(),
					name: arcadeNameSchema.optional(),
					nickname: arcadeNicknameSchema.optional()
				})
				.refine(data => data.name !== undefined || data.nickname !== undefined, {
					message: "At least one field must be provided"
				})
		),
		async c => {
			try {
				const { userId, permissions } = c.payload
				const { arcade, name, nickname } = c.req.valid("json")

				// Non-admin users can only rename arcades they own
				if (permissions !== UserRole.Admin) {
					const [ownership] = await db.execute<({ count: number } & RowDataPacket)[]>(
						"SELECT COUNT(*) as count FROM arcade_owner WHERE arcade = ? AND user = ? AND permissions = 1",
						[arcade, userId]
					)

					if (!ownership?.[0]?.count) {
						throw new HTTPException(403, {
							message: "You do not have permission to rename this arcade"
						})
					}
				}

				// Update name if provided
				if (name !== undefined) {
					await db.execute<ResultSetHeader>("UPDATE arcade SET name = ? WHERE id = ?", [name, arcade])
				}

				// Update nickname if provided
				if (nickname !== undefined) {
					await db.execute<ResultSetHeader>("UPDATE arcade SET nickname = ? WHERE id = ?", [nickname, arcade])
				}

				return c.json({
					success: true,
					message: "Arcade name updated successfully"
				})
			} catch (error) {
				throw rethrowWithMessage("Failed to update arcade name", error)
			}
		}
	)
	.post(
		"update",
		validateJson(
			z.object({
				arcade: z.number().int().positive(),
				user: z.number().int().positive()
			})
		),
		async c => {
			try {
				const { permissions } = c.payload
				const { arcade, user } = c.req.valid("json")

				if (permissions !== UserRole.Admin) {
					throw new HTTPException(403, {
						message: "Admin permissions required"
					})
				}

				// Update the user column n arcade_owner table
				const [update] = await db.execute<ResultSetHeader>(
					`UPDATE arcade_owner
									SET user = ?
									WHERE arcade = ? AND permissions = 1`,
					[user, arcade]
				)

				if (update.affectedRows === 0) {
					throw new HTTPException(404, {
						message: "Arcade owner record not found"
					})
				}

				return c.json({
					success: true,
					message: "Arcade owner updated successfully"
				})
			} catch (error) {
				throw rethrowWithMessage("Failed to update arcade owner", error)
			}
		}
	)

export { ArcadeRoutes }
