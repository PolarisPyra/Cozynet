import { Hono } from "hono"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { DB, DaphnisUserOptionKey } from "@/app/shared/types"
import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

const PopnStaticMusic = new Hono().get("music", async c => {
	try {
		const [results] = await db.execute<(DB.PopnStaticMusic & RowDataPacket)[]>(`
			SELECT m.*
			FROM popn_static_music m
			INNER JOIN (
				SELECT songId, chartId, MAX(version) AS maxVersion
				FROM popn_static_music
				GROUP BY songId, chartId
			) latest
				ON latest.songId = m.songId
				AND latest.chartId = m.chartId
				AND latest.maxVersion = m.version
			ORDER BY m.songId, m.chartId
		`)

		return c.json(results)
	} catch (error) {
		throw rethrowWithMessage("Failed to get Pop'n static music", error)
	}
})

const PopnProfileRoutes = new Hono().get("playlog", async c => {
	try {
		const { userId } = c.payload
		const [results] = await db.execute<(DB.PopnPlaylog & RowDataPacket)[]>(
			`
			SELECT
				p.*,
				1 AS cnt,
				m.title,
				m.artist,
				m.genre,
				m.category,
				m.difficulty,
				m.chartId
			FROM popn_playlog p
			LEFT JOIN (
				SELECT songId, chartId, MAX(version) AS maxVersion
				FROM popn_static_music
				GROUP BY songId, chartId
			) latest
				ON latest.songId = p.music_num
				AND latest.chartId = p.sheet_num
			LEFT JOIN popn_static_music m
				ON m.songId = latest.songId
				AND m.chartId = latest.chartId
				AND m.version = latest.maxVersion
			WHERE p.user_id = ?
			ORDER BY p.playdate DESC, p.id DESC
		`,
			[userId]
		)

		return c.json(results)
	} catch (error) {
		throw rethrowWithMessage("Failed to get Pop'n playlog", error)
	}
})

const popnSettings = {
	musicPhase: {
		key: DaphnisUserOptionKey.PopnMusicPhase,
		defaultValue: 7
	},
	extraStagePhase: {
		key: DaphnisUserOptionKey.PopnExtraStagePhase,
		defaultValue: 0
	},
	tataitePonponPhase: {
		key: DaphnisUserOptionKey.PopnTataitePonponPhase,
		defaultValue: 0
	},
	forceUnlockSongs: {
		key: DaphnisUserOptionKey.PopnForceUnlockSongs,
		defaultValue: 1
	},
	forceUnlockDeco: {
		key: DaphnisUserOptionKey.PopnForceUnlockDeco,
		defaultValue: 1
	},
	enableTimePlayMode: {
		key: DaphnisUserOptionKey.PopnEnableTimePlayMode,
		defaultValue: 1
	},
	enableLicenses: {
		key: DaphnisUserOptionKey.PopnEnableLicenses,
		defaultValue: 1
	}
} as const

const popnSettingsSchema = z.object({
	musicPhase: z.number().int().min(0).max(7).optional(),
	extraStagePhase: z.number().int().min(0).max(3).optional(),
	tataitePonponPhase: z.number().int().min(0).max(11).optional(),
	forceUnlockSongs: z.boolean().optional(),
	forceUnlockDeco: z.boolean().optional(),
	enableTimePlayMode: z.boolean().optional(),
	enableLicenses: z.boolean().optional()
})

const PopnSettingsRoutes = new Hono()
	.get("/", async c => {
		try {
			const { userId } = c.payload
			const keys = Object.values(popnSettings).map(setting => setting.key)
			const [rows] = await db.execute<(Pick<DB.DaphnisUserOption, "key" | "value"> & RowDataPacket)[]>(
				`SELECT \`key\`, value FROM cozynet_user_option WHERE user = ? AND \`key\` IN (${keys.map(() => "?").join(", ")})`,
				[userId, ...keys]
			)
			const values = new Map(rows.map(row => [row.key, Number(row.value)]))

			return c.json({
				musicPhase: values.get(popnSettings.musicPhase.key) ?? popnSettings.musicPhase.defaultValue,
				extraStagePhase: values.get(popnSettings.extraStagePhase.key) ?? popnSettings.extraStagePhase.defaultValue,
				tataitePonponPhase:
					values.get(popnSettings.tataitePonponPhase.key) ?? popnSettings.tataitePonponPhase.defaultValue,
				forceUnlockSongs:
					(values.get(popnSettings.forceUnlockSongs.key) ?? popnSettings.forceUnlockSongs.defaultValue) !== 0,
				forceUnlockDeco:
					(values.get(popnSettings.forceUnlockDeco.key) ?? popnSettings.forceUnlockDeco.defaultValue) !== 0,
				enableTimePlayMode:
					(values.get(popnSettings.enableTimePlayMode.key) ?? popnSettings.enableTimePlayMode.defaultValue) !== 0,
				enableLicenses: (values.get(popnSettings.enableLicenses.key) ?? popnSettings.enableLicenses.defaultValue) !== 0
			})
		} catch (error) {
			throw rethrowWithMessage("Failed to get Pop'n settings", error)
		}
	})
	.post("/", validateJson(popnSettingsSchema), async c => {
		try {
			const { userId } = c.payload
			const settings = c.req.valid("json")
			const settingEntries = Object.entries(settings) as [keyof typeof popnSettings, number | boolean][]

			for (const [name, value] of settingEntries) {
				const definition = popnSettings[name]
				const storedValue = typeof value === "boolean" ? (value ? 1 : 0) : value
				const [update] = await db.execute<ResultSetHeader>(
					"UPDATE cozynet_user_option SET value = ? WHERE user = ? AND `key` = ?",
					[storedValue, userId, definition.key]
				)

				if (update.affectedRows === 0) {
					await db.execute<ResultSetHeader>("INSERT INTO cozynet_user_option (user, `key`, value) VALUES (?, ?, ?)", [
						userId,
						definition.key,
						storedValue
					])
				}
			}

			return c.json(settings)
		} catch (error) {
			throw rethrowWithMessage("Failed to update Pop'n settings", error)
		}
	})
	.get("/forceUnlock", async c => {
		try {
			const { userId } = c.payload
			const [rows] = await db.execute<(Pick<DB.DaphnisUserOption, "value"> & RowDataPacket)[]>(
				"SELECT value FROM cozynet_user_option WHERE user = ? AND `key` = ?",
				[userId, DaphnisUserOptionKey.PopnForceUnlockSongs]
			)

			return c.json({ forceUnlockSongs: Number(rows[0]?.value ?? 0) !== 0 })
		} catch (error) {
			throw rethrowWithMessage("Failed to get Pop'n song force-unlock setting", error)
		}
	})
	.post("/forceUnlock", validateJson(z.object({ enabled: z.boolean() })), async c => {
		try {
			const { userId } = c.payload
			const { enabled } = c.req.valid("json")
			const value = enabled ? 1 : 0
			const [update] = await db.execute<ResultSetHeader>(
				"UPDATE cozynet_user_option SET value = ? WHERE user = ? AND `key` = ?",
				[value, userId, DaphnisUserOptionKey.PopnForceUnlockSongs]
			)

			if (update.affectedRows === 0) {
				await db.execute<ResultSetHeader>("INSERT INTO cozynet_user_option (user, `key`, value) VALUES (?, ?, ?)", [
					userId,
					DaphnisUserOptionKey.PopnForceUnlockSongs,
					value
				])
			}

			return c.json({ forceUnlockSongs: enabled })
		} catch (error) {
			throw rethrowWithMessage("Failed to update Pop'n song force-unlock setting", error)
		}
	})

export const PopnRoutes = new Hono()
	.route("static", PopnStaticMusic)
	.route("profile", PopnProfileRoutes)
	.route("settings", PopnSettingsRoutes)
