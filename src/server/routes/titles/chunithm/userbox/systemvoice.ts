import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson, validateParams } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

interface SystemVoiceItem {
	systemVoiceId: number
	label: string
	imagePath: string
	locked: boolean
}

const SearchRequestSchema = z.object({
	filter: z.object({
		locked: z.boolean().nullable()
	})
})

const EquipRequestSchema = z.object({
	systemVoiceId: z.number()
})

async function getCurrentSystemVoice(userId: number, version: number): Promise<SystemVoiceItem | null> {
	const [result] = await db.execute<(SystemVoiceItem & RowDataPacket)[]>(
		`
		SELECT
			dssv.systemVoiceId,
			dssv.name as label,
			dssv.imagePath,
			CASE
				WHEN cii.itemId IS NOT NULL THEN 0
				ELSE 1
			END as locked
		FROM chuni_profile_data cpd
		JOIN cozynet_static_chuni_system_voice dssv ON cpd.voiceId = dssv.systemVoiceId
		LEFT JOIN chuni_item_item cii ON cii.itemId = dssv.systemVoiceId AND cii.user = cpd.user AND cii.itemKind = 9
		LEFT JOIN chuni_static_opts cso ON dssv.opt = cso.id
		LEFT JOIN cozynet_web_permissions dwp ON dwp.user = ?
		WHERE cpd.user = ? AND cpd.version = ? AND dssv.version <= ?
		AND (dwp.status = 1 OR cso.isEnable = 1 OR cso.name IS NULL)
		LIMIT 1
		`,
		[userId, userId, version, version]
	)

	return result.length > 0 ? result[0] : null
}

const routes = new Hono()
	// Get current equipped systemvoice
	.get("", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.chunithm_version

			const result = await getCurrentSystemVoice(userId, version)
			if (!result) {
				// Return default system voice if none found
				return c.json({
					systemVoiceId: 1,
					label: "Default",
					imagePath: "CHU_UI_SystemVoice_000001",
					locked: false
				})
			}

			return c.json(result)
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch current systemvoice", error)
		}
	})

	// Equip systemvoice
	.post("", validateJson(EquipRequestSchema), async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.chunithm_version
			const { systemVoiceId } = c.req.valid("json")

			// Check if user owns this systemvoice (itemKind 9 for system voices)
			const [ownershipResult] = await db.execute<RowDataPacket[]>(
				`
				SELECT 1
				FROM chuni_item_item
				WHERE user = ? AND itemId = ? AND itemKind = 9
				`,
				[userId, systemVoiceId]
			)

			if (ownershipResult.length === 0) {
				throw new HTTPException(403, {
					message: "You don't own this systemvoice"
				})
			}

			// Update profile with new systemvoice
			const [result] = await db.execute<ResultSetHeader>(
				`
				UPDATE chuni_profile_data
				SET voiceId = ?
				WHERE user = ? AND version = ?
				`,
				[systemVoiceId, userId, version]
			)

			if (result.affectedRows === 0) {
				throw new HTTPException(404, {
					message: "Profile not found"
				})
			}

			// Return updated systemvoice
			const updatedSystemVoice = await getCurrentSystemVoice(userId, version)
			return c.json(updatedSystemVoice)
		} catch (error) {
			throw rethrowWithMessage("Failed to equip systemvoice", error)
		}
	})

	// Search systemvoices
	.post("search", validateJson(SearchRequestSchema), async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.chunithm_version
			const { filter } = c.req.valid("json")

			let additionalWhere = ""
			const params: any[] = [userId, userId, version, userId, version]

			if (filter.locked === true) {
				additionalWhere = " AND cii.itemId IS NULL"
			} else if (filter.locked === false) {
				additionalWhere = " AND cii.itemId IS NOT NULL"
			}

			// Get total count
			const [countResult] = await db.execute<({ total: number } & RowDataPacket)[]>(
				`
			SELECT COUNT(DISTINCT dssv.systemVoiceId) as total
			FROM cozynet_static_chuni_system_voice dssv
			LEFT JOIN chuni_item_item cii ON cii.itemId = dssv.systemVoiceId AND cii.user = ? AND cii.itemKind = 9
			LEFT JOIN chuni_static_opts cso ON dssv.opt = cso.id
			LEFT JOIN cozynet_web_permissions dwp ON dwp.user = ?
			WHERE dssv.version <= ?
			AND (dwp.status = 1 OR cso.isEnable = 1 OR cso.name IS NULL)${additionalWhere}
			`,
				[userId, userId, version]
			)

			const total = countResult.length > 0 ? countResult[0].total : 0

			// Get paginated results
			const [results] = await db.execute<
				(SystemVoiceItem & { sort_current: number; total_count: number } & RowDataPacket)[]
			>(
				`
			SELECT DISTINCT
				dssv.systemVoiceId,
				dssv.name as label,
				dssv.imagePath,
				CASE
					WHEN cii.itemId IS NOT NULL THEN 0
					ELSE 1
				END as locked,
				CASE
					WHEN cpd.voiceId = dssv.systemVoiceId THEN 0
					ELSE 1
				END as sort_current,
				COUNT(*) OVER() as total_count
			FROM cozynet_static_chuni_system_voice dssv
			LEFT JOIN chuni_item_item cii ON cii.itemId = dssv.systemVoiceId AND cii.user = ? AND cii.itemKind = 9
			LEFT JOIN chuni_profile_data cpd ON cpd.user = ? AND cpd.version = ?
			LEFT JOIN chuni_static_opts cso ON dssv.opt = cso.id
			LEFT JOIN cozynet_web_permissions dwp ON dwp.user = ?
			WHERE dssv.version <= ?
			AND (dwp.status = 1 OR cso.isEnable = 1 OR cso.name IS NULL)${additionalWhere}
			ORDER BY
				locked DESC,
				dssv.systemVoiceId DESC
			`,
				params
			)

			const items = results.map(({ sort_current, total_count, ...item }) => ({
				...item,
				locked: Boolean(item.locked)
			}))

			return c.json({
				items,
				total
			})
		} catch (error) {
			throw rethrowWithMessage("Failed to search systemvoices", error)
		}
	})

	// Unlock systemvoice
	.patch(
		"unlock/:id",
		validateParams(
			z.object({
				id: z
					.string()
					.transform(val => parseInt(val))
					.refine(val => !isNaN(val), {
						message: "Invalid systemvoice ID"
					})
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { id } = c.req.param()

				// Check if systemvoice exists
				const [systemvoiceResult] = await db.execute<RowDataPacket[]>(
					`
				SELECT systemVoiceId FROM cozynet_static_chuni_system_voice WHERE systemVoiceId = ?
				`,
					[id]
				)

				if (systemvoiceResult.length === 0) {
					throw new HTTPException(404, {
						message: "Systemvoice not found"
					})
				}

				// Check if already owned
				const [ownershipResult] = await db.execute<RowDataPacket[]>(
					`
				SELECT 1 FROM chuni_item_item WHERE user = ? AND itemId = ? AND itemKind = 9
				`,
					[userId, id]
				)

				if (ownershipResult.length > 0) {
					throw new HTTPException(400, {
						message: "You already own this systemvoice"
					})
				}

				// Add to user's inventory (itemKind 9 for system voices)
				await db.execute<ResultSetHeader>(
					`
				INSERT INTO chuni_item_item (user, itemId, itemKind, stock, isValid)
				VALUES (?, ?, 9, 1, 1)
				`,
					[userId, id]
				)

				return c.json({ message: "Systemvoice unlocked successfully" })
			} catch (error) {
				throw rethrowWithMessage("Failed to unlock systemvoice", error)
			}
		}
	)

export default routes
