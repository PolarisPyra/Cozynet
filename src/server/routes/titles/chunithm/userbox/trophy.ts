import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson, validateParams } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

interface TrophyItem {
	trophyId: number
	label: string
	imagePath: string
	locked: boolean
	slot: "main" | "sub1" | "sub2"
	trophyRareType: number
}

const defaultTrophy = {
	trophyId: -1,
	label: "",
	imagePath: null,
	locked: false,
	slot: "main",
	trophyRareType: 9
}

const routes = new Hono()
	.get("", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.chunithm_version

			const [result] = await db.execute<RowDataPacket[]>(
				`
                SELECT DISTINCT
                    dst.trophyId,
                    dst.name as label,
                    dst.imagePath,
                    dst.rareType AS trophyRareType,
					CASE
						WHEN dst.trophyId = cpd.trophyId THEN "main"
						WHEN dst.trophyId = cpd.trophyIdSub1 THEN "sub1"
						WHEN dst.trophyId = cpd.trophyIdSub2 THEN "sub2"
						ELSE null
					END as slot,
					FALSE as locked
                FROM cozynet_static_chuni_trophy dst
                INNER JOIN chuni_profile_data cpd ON cpd.user = ? AND (
						cpd.trophyId = dst.trophyId
					OR  cpd.trophyIdSub1 = dst.trophyId
					OR  cpd.trophyIdSub2 = dst.trophyId
				)
                LEFT JOIN chuni_static_opts cso ON dst.opt = cso.id
                LEFT JOIN cozynet_web_permissions dwp ON dwp.user = ?
                WHERE cpd.version = ?
				  AND dst.version <= ?
				  AND (dwp.status = 1 OR cso.isEnable = 1 OR cso.name IS NULL)
                `,
				[userId, userId, version, version]
			)

			return c.json([
				result.find(r => r.slot === "main") ?? { ...defaultTrophy, slot: "main" },
				result.find(r => r.slot === "sub1") ?? { ...defaultTrophy, slot: "sub1" },
				result.find(r => r.slot === "sub2") ?? { ...defaultTrophy, slot: "sub2" }
			])
		} catch (error) {
			throw rethrowWithMessage("Failed to get current trophy", error)
		}
	})

	.post(
		"",
		validateJson(
			z.object({
				trophyId: z.number().int().min(0),
				slot: z.enum(["main", "sub1", "sub2"])
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const version = versions.chunithm_version
				const { trophyId, slot } = c.req.valid("json")

				// Check if user owns this trophy (trophy ID 0 is always owned - means no trophy)
				if (trophyId !== 0) {
					const [ownership] = await db.execute<RowDataPacket[]>(
						`
                        SELECT 1 FROM chuni_item_item
                        WHERE user = ? AND itemId = ? AND itemKind = 3
                    `,
						[userId, trophyId]
					)

					if (ownership.length === 0) {
						throw new HTTPException(400, {
							message: "You don't own this trophy"
						})
					}
				}

				let equipColumn = "trophyId"
				switch (slot) {
					case "sub1":
						equipColumn = "trophyIdSub1"
						break
					case "sub2":
						equipColumn = "trophyIdSub2"
						break
					default:
						break
				}
				// Update profile
				await db.execute<ResultSetHeader>(
					`
                    UPDATE chuni_profile_data
                    SET ${equipColumn} =
						(
							CASE
								WHEN ${equipColumn} = ? THEN null
								ELSE ?
							END
						)
                    WHERE user = ? AND version = ?
                `,
					[trophyId, trophyId, userId, version]
				)

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to update trophy", error)
			}
		}
	)

	.post(
		"search",
		validateJson(
			z.object({
				filter: z.object({
					locked: z.boolean().nullable(),
					rareType: z.number().nullable()
				})
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const version = versions.chunithm_version

				const { filter } = c.req.valid("json")
				const { locked, rareType } = filter

				let additionalWhere = ""
				const params = [userId, userId, version, userId, version]

				if (locked === true) {
					additionalWhere = " AND cii.user IS NULL AND dst.trophyId != 0"
				} else if (locked === false) {
					additionalWhere = " AND (cii.user IS NOT NULL OR dst.trophyId = 0)"
				}

				if (rareType !== null) {
					additionalWhere += " AND dst.rareType = ?"
					params.push(rareType)
				}

				const query = `
                    SELECT
                        dst.trophyId,
                        dst.name AS label,
                        dst.imagePath,
                        dst.rareType AS trophyRareType,
                        dst.version,
                        CASE
                            WHEN cii.user IS NULL AND dst.trophyId != 0 THEN 1
                            ELSE 0
                        END AS locked,
                        CASE
                            WHEN cpd.trophyId = dst.trophyId THEN 1
                            ELSE 0
                        END AS equipped,
                        COUNT(*) OVER() AS total_count
                    FROM cozynet_static_chuni_trophy dst
                    LEFT JOIN chuni_item_item cii
                        ON cii.itemId = dst.trophyId
                        AND cii.user = ?
                        AND cii.itemKind = 3
                    LEFT JOIN chuni_profile_data cpd
                        ON cpd.user = ?
                        AND cpd.version = ?
                        AND cpd.trophyId = dst.trophyId
                    LEFT JOIN chuni_static_opts cso ON dst.opt = cso.id
                    LEFT JOIN cozynet_web_permissions dwp ON dwp.user = ?
                WHERE dst.version <= ?
                        AND (dwp.status = 1 OR cso.isEnable = 1 OR cso.name IS NULL)${additionalWhere}
                    ORDER BY
                        locked ASC,
                        dst.trophyId DESC
                `

				const [items] = await db.execute<(TrophyItem & { total_count: number } & RowDataPacket)[]>(query, params)

				const totalCount = items.length > 0 ? items[0].total_count : 0

				return c.json({
					items: items.map(({ total_count, ...item }) => item),
					total: totalCount
				})
			} catch (error) {
				throw rethrowWithMessage("Failed to search trophies", error)
			}
		}
	)

	.patch("unlock/:id", validateParams(z.object({ id: z.string().regex(/^\d+$/).transform(Number) })), async c => {
		try {
			const { userId } = c.payload
			const { id } = c.req.param()

			// Add trophy to user's inventory
			await db.execute<ResultSetHeader>(
				`INSERT IGNORE INTO chuni_item_item (user, itemId, itemKind, stock, isValid)
                VALUES (?, ?, 3, 1, 1)`,
				[userId, id]
			)

			return c.json({ success: true })
		} catch (error) {
			throw rethrowWithMessage("Failed to unlock trophy", error)
		}
	})

export default routes
