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
                WHEN cii.user IS NULL THEN 1
                ELSE 0
            END AS locked,
            1 as equipped
        FROM chuni_profile_data cpd
        JOIN cozynet_static_chuni_nameplate dsn
            ON dsn.nameplateId = cpd.nameplateId
            AND dsn.version <= ?
        LEFT JOIN chuni_item_item cii
            ON cii.itemId = dsn.nameplateId
            AND cii.user = ?
            AND cii.itemKind = 1
        LEFT JOIN chuni_static_opts cso
            ON dsn.opt = cso.id
        LEFT JOIN cozynet_web_permissions dwp
            ON dwp.user = ?
        WHERE cpd.user = ?
            AND cpd.version = ?
            AND (dwp.status = 1 OR cso.isEnable = 1 OR cso.name IS NULL)
        `,
		[version, userId, userId, userId, version]
	)
	return result
}

const routes = new Hono()
	.get("", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.chunithm_version

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
				const version = versions.chunithm_version
				const { nameplateId } = c.req.valid("json")

				// Verify user owns the nameplate
				const [ownership] = await db.execute<RowDataPacket[]>(
					`SELECT 1 FROM chuni_item_item
                    WHERE user = ? AND itemId = ? AND itemKind = 1`,
					[userId, nameplateId]
				)

				if (ownership.length === 0) {
					throw new HTTPException(400, {
						message: "You don't own this nameplate"
					})
				}

				// Update profile
				await db.execute<ResultSetHeader>(
					`UPDATE chuni_profile_data
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
				const version = versions.chunithm_version
				const { filter } = c.req.valid("json")
				const { locked } = filter

				let whereClause = "WHERE dsn.version <= ?"
				const params = [version]

				if (locked === true) {
					whereClause += " AND cii.user IS NULL"
				} else if (locked === false) {
					whereClause += " AND cii.user IS NOT NULL"
				}

				const query = `
                SELECT
                    dsn.nameplateId,
                    dsn.imagePath,
                    dsn.name AS label,
                    CASE
                        WHEN cii.user IS NULL THEN 1
                        ELSE 0
                    END AS locked,
                    CASE
                        WHEN cpd.nameplateId = dsn.nameplateId
                        AND cpd.user = ?
                        AND cpd.version = ? THEN 1
                        ELSE 0
                    END AS equipped,
                    COUNT(*) OVER() AS total_count
                FROM cozynet_static_chuni_nameplate dsn
                LEFT JOIN chuni_item_item cii
                    ON cii.itemId = dsn.nameplateId
                    AND cii.user = ?
                    AND cii.itemKind = 1
                LEFT JOIN chuni_profile_data cpd
                    ON cpd.nameplateId = dsn.nameplateId
                    AND cpd.user = ?
                    AND cpd.version = ?
                LEFT JOIN chuni_static_opts cso
                    ON dsn.opt = cso.id
                LEFT JOIN cozynet_web_permissions dwp
                    ON dwp.user = ?
                ${whereClause}
                    AND (dwp.status = 1 OR cso.isEnable = 1 OR cso.name IS NULL)
                ORDER BY
                    locked DESC,
                    dsn.nameplateId DESC
                `

				params.unshift(userId, version, userId, userId, version, userId)
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
					`INSERT IGNORE INTO chuni_item_item
                    (user, itemId, itemKind, stock, isValid)
                    VALUES (?, ?, 1, 1, 1)`,
					[userId, nameplateId]
				)

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to unlock nameplate", error)
			}
		}
	)

export default routes
