import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson, validateParams } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

interface CharacterItem {
	characterId: number
	imagePath: string
	label: string
	locked: boolean
	equipped?: boolean
}

async function getCurrentCharacter(userId: number, version: number): Promise<CharacterItem[]> {
	const [result] = await db.execute<(CharacterItem & RowDataPacket)[]>(
		`
        SELECT
            dsn.characterId,
            dsn.imagePath,
            dsn.name AS label,
            CASE
                WHEN cic.user IS NULL THEN 1
                ELSE 0
            END AS locked,
            1 as equipped
        FROM chuni_profile_data cpd
        JOIN cozynet_static_chuni_character dsn
            ON dsn.characterId = cpd.characterId
            AND dsn.version <= ?
        LEFT JOIN chuni_item_character cic
            ON cic.characterId = dsn.characterId
            AND cic.user = ?
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

			const result = await getCurrentCharacter(userId, version)
			// If no current character, return null to indicate "no selection" instead of 404
			if (result.length === 0) {
				return c.json(null)
			}

			return c.json(result[0])
		} catch (error) {
			throw rethrowWithMessage("Failed to get current character", error)
		}
	})
	.post(
		"",
		validateJson(
			z.object({
				characterId: z.number().int().positive()
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const version = versions.chunithm_version
				const { characterId } = c.req.valid("json")

				// Verify user owns the character
				const [ownership] = await db.execute<RowDataPacket[]>(
					`SELECT 1 FROM chuni_item_character
                    WHERE user = ? AND characterId = ?`,
					[userId, characterId]
				)

				if (ownership.length === 0) {
					throw new HTTPException(400, {
						message: "You don't own this character"
					})
				}

				// Update profile
				await db.execute<ResultSetHeader>(
					`UPDATE chuni_profile_data
                    SET characterId = ?
                    WHERE user = ? AND version = ?`,
					[characterId, userId, version]
				)

				// Get updated character data
				const result = await getCurrentCharacter(userId, version)
				if (result.length === 0) {
					return c.json(null)
				}
				return c.json(result[0])
			} catch (error) {
				throw rethrowWithMessage("Failed to update character", error)
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
					whereClause += " AND cic.user IS NULL"
				} else if (locked === false) {
					whereClause += " AND cic.user IS NOT NULL"
				}

				const query = `
                SELECT
                    dsn.characterId,
                    dsn.imagePath,
                    dsn.name AS label,
                    CASE
                        WHEN cic.user IS NULL THEN 1
                        ELSE 0
                    END AS locked,
                    CASE
                        WHEN cpd.characterId = dsn.characterId
                        AND cpd.user = ?
                        AND cpd.version = ? THEN 1
                        ELSE 0
                    END AS equipped,
                    COUNT(*) OVER() AS total_count
                FROM cozynet_static_chuni_character dsn
                LEFT JOIN chuni_item_character cic
                    ON cic.characterId = dsn.characterId
                    AND cic.user = ?
                LEFT JOIN chuni_profile_data cpd
                    ON cpd.characterId = dsn.characterId
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
                    dsn.characterId DESC
                `

				params.unshift(userId, version, userId, userId, version, userId)
				const [items] = await db.execute<(CharacterItem & { total_count: number } & RowDataPacket)[]>(query, params)
				const totalCount = items.length > 0 ? items[0].total_count : 0

				const result = {
					items: items.map(({ total_count, ...item }) => item),
					total: totalCount
				}

				return c.json(result)
			} catch (error) {
				throw rethrowWithMessage("Failed to search characters", error)
			}
		}
	)
	.patch(
		"unlock/:characterId",
		validateParams(z.object({ characterId: z.string().regex(/^\d+$/).transform(Number) })),
		async c => {
			try {
				const { userId } = c.payload
				const { characterId } = c.req.param()

				// Add character to user's inventory
				await db.execute<ResultSetHeader>(
					`INSERT IGNORE INTO chuni_item_character
                    (user, characterId, level, isValid, assignIllust)
                    VALUES (?, ?, 1, 1, ?)`,
					[userId, characterId, characterId]
				)

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to unlock character", error)
			}
		}
	)

export default routes
