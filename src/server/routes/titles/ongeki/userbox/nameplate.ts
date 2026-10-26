import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson, validateParams } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

interface NameplateItem {
	nameplateId: number
	imagePath: string
	label: string
	locked: boolean
	equipped?: boolean
}

async function getCurrentNameplate(userId: number, version: number): Promise<NameplateItem[]> {
	const [result] = await db.execute<(NameplateItem & RowDataPacket)[]>(
		`
        SELECT
            dsn.nameplateId,
            dsn.imagePath,
            dsn.name AS label,
            CASE
                WHEN oui.user IS NULL THEN 1
                ELSE 0
            END AS locked,
            1 as equipped
        FROM ongeki_profile_data opd
        JOIN cozynet_static_ongeki_nameplates dsn
            ON dsn.nameplateId = opd.nameplateId
            AND dsn.version = ?
        LEFT JOIN ongeki_user_item oui
            ON oui.itemId = dsn.nameplateId
            AND oui.user = ?
            AND oui.itemKind = 19
        WHERE opd.user = ?
            AND opd.version = ?
        `,
		[version, userId, userId, version]
	)
	return result
}

const routes = new Hono()
	.get("", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.ongeki_version

			const result = await getCurrentNameplate(userId, version)
			// If no current nameplate, return null to indicate "no selection" instead of 404
			if (result.length === 0) {
				return c.json(null)
			}

			return c.json(result[0])
		} catch (error) {
			throw rethrowWithMessage("Failed to get current nameplate", error)
		}
	})
	.post(
		"",
		validateJson(
			z.object({
				nameplateId: z.number().int().positive()
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const version = versions.ongeki_version
				const { nameplateId } = c.req.valid("json")

				// Verify user owns the nameplate
				const [ownership] = await db.execute<RowDataPacket[]>(
					`SELECT 1 FROM ongeki_user_item
                    WHERE user = ? AND itemId = ? AND itemKind = 19`,
					[userId, nameplateId]
				)

				if (ownership.length === 0) {
					throw new HTTPException(400, {
						message: "You don't own this nameplate"
					})
				}

				// Update profile
				await db.execute<ResultSetHeader>(
					`UPDATE ongeki_profile_data
                    SET nameplateId = ?
                    WHERE user = ? AND version = ?`,
					[nameplateId, userId, version]
				)

				// Get updated nameplate data
				const result = await getCurrentNameplate(userId, version)
				return c.json(result[0])
			} catch (error) {
				throw rethrowWithMessage("Failed to update nameplate", error)
			}
		}
	)
	.post(
		"search",
		validateJson(
			z.object({
				filter: z.object({
					locked: z.boolean().nullable()
				})
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const version = versions.ongeki_version
				const { filter } = c.req.valid("json")
				const { locked } = filter

				let whereClause = "WHERE dsn.version = ?"
				const params = [version]

				if (locked === true) {
					whereClause += " AND oui.user IS NULL"
				} else if (locked === false) {
					whereClause += " AND oui.user IS NOT NULL"
				}

				const query = `
                SELECT
                    dsn.nameplateId,
                    dsn.imagePath,
                    dsn.name AS label,
                    CASE
                        WHEN oui.user IS NULL THEN 1
                        ELSE 0
                    END AS locked,
                    CASE
                        WHEN opd.nameplateId = dsn.nameplateId
                        AND opd.user = ?
                        AND opd.version = ? THEN 1
                        ELSE 0
                    END AS equipped,
                    COUNT(*) OVER() AS total_count
                FROM cozynet_static_ongeki_nameplates dsn
                LEFT JOIN ongeki_user_item oui
                    ON oui.itemId = dsn.nameplateId
                    AND oui.user = ?
                    AND oui.itemKind = 19
                LEFT JOIN ongeki_profile_data opd
                    ON opd.nameplateId = dsn.nameplateId
                    AND opd.user = ?
                    AND opd.version = ?
                ${whereClause}
                ORDER BY
                    locked DESC,
                    dsn.nameplateId DESC
                `

				params.unshift(userId, version, userId, userId, version)
				const [items] = await db.execute<(NameplateItem & { total_count: number } & RowDataPacket)[]>(query, params)
				const totalCount = items.length > 0 ? items[0].total_count : 0

				const result = {
					items: items.map(({ total_count, ...item }) => item),
					total: totalCount
				}

				return c.json(result)
			} catch (error) {
				throw rethrowWithMessage("Failed to search nameplates", error)
			}
		}
	)
	.patch(
		"unlock/:nameplateId",
		validateParams(z.object({ nameplateId: z.string().regex(/^\d+$/).transform(Number) })),
		async c => {
			try {
				const { userId } = c.payload
				const { nameplateId } = c.req.param()

				// Add nameplate to user's inventory
				await db.execute<ResultSetHeader>(
					`INSERT IGNORE INTO ongeki_user_item
                    (user, itemId, itemKind, stock, isValid)
                    VALUES (?, ?, 19, 1, 1)`,
					[userId, nameplateId]
				)

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to unlock nameplate", error)
			}
		}
	)

export default routes
