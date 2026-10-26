import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson, validateParams } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

interface StageItem {
	stageId: number
	imagePath: string
	label: string
	locked: boolean
	equipped?: boolean
}

async function getCurrentStage(userId: number, version: number): Promise<StageItem[]> {
	if (Number(version) === 19) {
		const [result] = await db.execute<(StageItem & RowDataPacket)[]>(
			`
				SELECT
					dsn.stageId,
					dsn.imagePath,
					dsn.name AS label,
					CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
					1 AS equipped
				FROM chuni_profile_data cpd
				INNER JOIN cozynet_static_chuni_stages dsn
					ON dsn.stageId = cpd.stageId
					AND dsn.version <= ?
				LEFT JOIN chuni_item_item cii
					ON cii.itemId = dsn.stageId
					AND cii.user = ?
					AND cii.itemKind = 13
				LEFT JOIN chuni_static_opts cso
					ON dsn.opt = cso.id
				LEFT JOIN cozynet_web_permissions dwp
					ON dwp.user = ?
				WHERE cpd.user = ?
					AND cpd.version = ?
					AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
					AND dsn.name != 'Linked VERSE'
			`,
			[version, userId, userId, userId, version]
		)
		return result
	}

	const [result] = await db.execute<(StageItem & RowDataPacket)[]>(
		`
			SELECT
				dsn.stageId,
				dsn.imagePath,
				dsn.name AS label,
				CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
				1 AS equipped
			FROM chuni_profile_data cpd
			INNER JOIN cozynet_static_chuni_stages dsn
				ON dsn.stageId = cpd.stageId
				AND dsn.version <= ?
			LEFT JOIN chuni_item_item cii
				ON cii.itemId = dsn.stageId
				AND cii.user = ?
				AND cii.itemKind = 13
			LEFT JOIN chuni_static_opts cso
				ON dsn.opt = cso.id
			LEFT JOIN cozynet_web_permissions dwp
				ON dwp.user = ?
			WHERE cpd.user = ?
				AND cpd.version = ?
				AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
				AND dsn.name != 'Linked VERSE'
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

			const result = await getCurrentStage(userId, version)
			if (result.length === 0) {
				return c.json(null)
			}

			return c.json(result[0])
		} catch (error) {
			throw rethrowWithMessage("Failed to get current stage", error)
		}
	})
	.post(
		"",
		validateJson(
			z.object({
				stageId: z.number().int().positive()
			})
		),
		async c => {
			try {
				const { userId, versions } = c.payload
				const version = versions.chunithm_version
				const { stageId } = c.req.valid("json")

				const [ownership] = await db.execute<RowDataPacket[]>(
					`
						SELECT 1
						FROM chuni_item_item
						WHERE user = ?
							AND itemId = ?
							AND itemKind = 13
					`,
					[userId, stageId]
				)

				if (ownership.length === 0) {
					throw new HTTPException(400, {
						message: "You don't own this stage"
					})
				}

				await db.execute<ResultSetHeader>(
					`
						UPDATE chuni_profile_data
						SET stageId = ?
						WHERE user = ?
							AND version = ?
					`,
					[stageId, userId, version]
				)

				const result = await getCurrentStage(userId, version)
				return c.json(result[0])
			} catch (error) {
				throw rethrowWithMessage("Failed to update stage", error)
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

				if (Number(version) === 19) {
					if (locked === true) {
						const [items] = await db.execute<(StageItem & { total_count: number } & RowDataPacket)[]>(
							`
								SELECT
									dsn.stageId,
									dsn.imagePath,
									dsn.name AS label,
									CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
									CASE
										WHEN cpd.stageId = dsn.stageId
											AND cpd.user = ?
											AND cpd.version = ?
										THEN 1
										ELSE 0
									END AS equipped,
									COUNT(*) OVER() AS total_count
								FROM cozynet_static_chuni_stages dsn
								LEFT JOIN chuni_item_item cii
									ON cii.itemId = dsn.stageId
									AND cii.user = ?
									AND cii.itemKind = 13
								LEFT JOIN chuni_profile_data cpd
									ON cpd.stageId = dsn.stageId
									AND cpd.user = ?
									AND cpd.version = ?
								LEFT JOIN chuni_static_opts cso
									ON dsn.opt = cso.id
								LEFT JOIN cozynet_web_permissions dwp
									ON dwp.user = ?
								WHERE dsn.version <= ?
									AND cii.user IS NULL
									AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
									AND dsn.name != 'Linked VERSE'
								ORDER BY
									locked DESC,
									dsn.stageId DESC
							`,
							[userId, version, userId, userId, version, userId, version]
						)
						const totalCount = items.length > 0 ? items[0].total_count : 0
						return c.json({
							items: items.map(({ total_count, ...item }) => item),
							total: totalCount
						})
					}

					if (locked === false) {
						const [items] = await db.execute<(StageItem & { total_count: number } & RowDataPacket)[]>(
							`
								SELECT
									dsn.stageId,
									dsn.imagePath,
									dsn.name AS label,
									CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
									CASE
										WHEN cpd.stageId = dsn.stageId
											AND cpd.user = ?
											AND cpd.version = ?
										THEN 1
										ELSE 0
									END AS equipped,
									COUNT(*) OVER() AS total_count
								FROM cozynet_static_chuni_stages dsn
								LEFT JOIN chuni_item_item cii
									ON cii.itemId = dsn.stageId
									AND cii.user = ?
									AND cii.itemKind = 13
								LEFT JOIN chuni_profile_data cpd
									ON cpd.stageId = dsn.stageId
									AND cpd.user = ?
									AND cpd.version = ?
								LEFT JOIN chuni_static_opts cso
									ON dsn.opt = cso.id
								LEFT JOIN cozynet_web_permissions dwp
									ON dwp.user = ?
								WHERE dsn.version <= ?
									AND cii.user IS NOT NULL
									AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
									AND dsn.name != 'Linked VERSE'
								ORDER BY
									locked DESC,
									dsn.stageId DESC
							`,
							[userId, version, userId, userId, version, userId, version]
						)
						const totalCount = items.length > 0 ? items[0].total_count : 0
						return c.json({
							items: items.map(({ total_count, ...item }) => item),
							total: totalCount
						})
					}

					const [items] = await db.execute<(StageItem & { total_count: number } & RowDataPacket)[]>(
						`
							SELECT
								dsn.stageId,
								dsn.imagePath,
								dsn.name AS label,
								CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
								CASE
									WHEN cpd.stageId = dsn.stageId
										AND cpd.user = ?
										AND cpd.version = ?
									THEN 1
									ELSE 0
								END AS equipped,
								COUNT(*) OVER() AS total_count
							FROM cozynet_static_chuni_stages dsn
							LEFT JOIN chuni_item_item cii
								ON cii.itemId = dsn.stageId
								AND cii.user = ?
								AND cii.itemKind = 13
							LEFT JOIN chuni_profile_data cpd
								ON cpd.stageId = dsn.stageId
								AND cpd.user = ?
								AND cpd.version = ?
							LEFT JOIN chuni_static_opts cso
								ON dsn.opt = cso.id
							LEFT JOIN cozynet_web_permissions dwp
								ON dwp.user = ?
							WHERE dsn.version <= ?
								AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
								AND dsn.name != 'Linked VERSE'
							ORDER BY
								locked DESC,
								dsn.stageId DESC
						`,
						[userId, version, userId, userId, version, userId, version]
					)
					const totalCount = items.length > 0 ? items[0].total_count : 0
					return c.json({
						items: items.map(({ total_count, ...item }) => item),
						total: totalCount
					})
				}

				if (locked === true) {
					const [items] = await db.execute<(StageItem & { total_count: number } & RowDataPacket)[]>(
						`
							SELECT
								dsn.stageId,
								dsn.imagePath,
								dsn.name AS label,
								CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
								CASE
									WHEN cpd.stageId = dsn.stageId
										AND cpd.user = ?
										AND cpd.version = ?
									THEN 1
									ELSE 0
								END AS equipped,
								COUNT(*) OVER() AS total_count
							FROM cozynet_static_chuni_stages dsn
							LEFT JOIN chuni_item_item cii
								ON cii.itemId = dsn.stageId
								AND cii.user = ?
								AND cii.itemKind = 13
							LEFT JOIN chuni_profile_data cpd
								ON cpd.stageId = dsn.stageId
								AND cpd.user = ?
								AND cpd.version = ?
							LEFT JOIN chuni_static_opts cso
								ON dsn.opt = cso.id
							LEFT JOIN cozynet_web_permissions dwp
								ON dwp.user = ?
							WHERE dsn.version <= ?
								AND cii.user IS NULL
								AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
								AND dsn.name != 'Linked VERSE'
							ORDER BY
								locked DESC,
								dsn.stageId DESC
						`,
						[userId, version, userId, userId, version, userId, version]
					)
					const totalCount = items.length > 0 ? items[0].total_count : 0
					return c.json({
						items: items.map(({ total_count, ...item }) => item),
						total: totalCount
					})
				}

				if (locked === false) {
					const [items] = await db.execute<(StageItem & { total_count: number } & RowDataPacket)[]>(
						`
							SELECT
								dsn.stageId,
								dsn.imagePath,
								dsn.name AS label,
								CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
								CASE
									WHEN cpd.stageId = dsn.stageId
										AND cpd.user = ?
										AND cpd.version = ?
									THEN 1
									ELSE 0
								END AS equipped,
								COUNT(*) OVER() AS total_count
							FROM cozynet_static_chuni_stages dsn
							LEFT JOIN chuni_item_item cii
								ON cii.itemId = dsn.stageId
								AND cii.user = ?
								AND cii.itemKind = 13
							LEFT JOIN chuni_profile_data cpd
								ON cpd.stageId = dsn.stageId
								AND cpd.user = ?
								AND cpd.version = ?
							LEFT JOIN chuni_static_opts cso
								ON dsn.opt = cso.id
							LEFT JOIN cozynet_web_permissions dwp
								ON dwp.user = ?
							WHERE dsn.version <= ?
								AND cii.user IS NOT NULL
								AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
								AND dsn.name != 'Linked VERSE'
							ORDER BY
								locked DESC,
								dsn.stageId DESC
						`,
						[userId, version, userId, userId, version, userId, version]
					)
					const totalCount = items.length > 0 ? items[0].total_count : 0
					return c.json({
						items: items.map(({ total_count, ...item }) => item),
						total: totalCount
					})
				}

				const [items] = await db.execute<(StageItem & { total_count: number } & RowDataPacket)[]>(
					`
						SELECT
							dsn.stageId,
							dsn.imagePath,
							dsn.name AS label,
							CASE WHEN cii.user IS NULL THEN 1 ELSE 0 END AS locked,
							CASE
								WHEN cpd.stageId = dsn.stageId
									AND cpd.user = ?
									AND cpd.version = ?
								THEN 1
								ELSE 0
							END AS equipped,
							COUNT(*) OVER() AS total_count
						FROM cozynet_static_chuni_stages dsn
						LEFT JOIN chuni_item_item cii
							ON cii.itemId = dsn.stageId
							AND cii.user = ?
							AND cii.itemKind = 13
						LEFT JOIN chuni_profile_data cpd
							ON cpd.stageId = dsn.stageId
							AND cpd.user = ?
							AND cpd.version = ?
						LEFT JOIN chuni_static_opts cso
							ON dsn.opt = cso.id
						LEFT JOIN cozynet_web_permissions dwp
							ON dwp.user = ?
						WHERE dsn.version <= ?
							AND (cso.name IS NULL OR ((dwp.status = 1 OR cso.isEnable = 1) AND cso.name NOT IN ('A000', 'A283')))
							AND dsn.name != 'Linked VERSE'
						ORDER BY
							locked DESC,
							dsn.stageId DESC
					`,
					[userId, version, userId, userId, version, userId, version]
				)
				const totalCount = items.length > 0 ? items[0].total_count : 0
				return c.json({
					items: items.map(({ total_count, ...item }) => item),
					total: totalCount
				})
			} catch (error) {
				throw rethrowWithMessage("Failed to search stages", error)
			}
		}
	)
	.patch(
		"unlock/:stageId",
		validateParams(z.object({ stageId: z.string().regex(/^\d+$/).transform(Number) })),
		async c => {
			try {
				const { userId } = c.payload
				const { stageId } = c.req.param()

				await db.execute<ResultSetHeader>(
					`
						INSERT IGNORE INTO chuni_item_item
							(user, itemId, itemKind, stock, isValid)
						VALUES (?, ?, 13, 1, 1)
					`,
					[userId, stageId]
				)

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to unlock stage", error)
			}
		}
	)

export default routes
