import { Hono } from "hono"
import type { RowDataPacket } from "mysql2"
import { z } from "zod"

import { DB } from "@/app/shared/types"
import { db } from "@/server/db"
import { validateParams, validateQuery } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

interface LeaderboardEntry {
	userId: number
	username: string
	score: number
	rank: number
	isFullCombo: number
	isAllBreak: number
	isFullBell: number
	playDate: string
}

const OngekiScoreLeaderboardRoutes = new Hono().get(
	":musicId/:chartId",
	validateParams(
		z.object({
			musicId: z.string().regex(/^\d+$/).transform(Number),
			chartId: z.string().regex(/^\d+$/).transform(Number)
		})
	),
	validateQuery(
		z.object({
			limit: z.string().regex(/^\d+$/).transform(Number).optional()
		})
	),
	async c => {
		try {
			const { versions } = c.payload
			const version = versions.ongeki_version
			const { musicId, chartId } = c.req.param()
			const queryParams = c.req.valid("query")
			const limit = Math.min(queryParams.limit || 100, 500)

			const [results] = await db.execute<(LeaderboardEntry & RowDataPacket)[]>(
				`
					SELECT
						osb.user as userId,
						COALESCE(
							(
								SELECT opd.userName
								FROM ongeki_profile_data opd
								WHERE opd.user = osb.user
								ORDER BY opd.version DESC
								LIMIT 1
							),
							'Player'
						) as username,
						osb.techScoreMax as score,
						osb.techScoreRank as rank,
						osb.isFullCombo,
						osb.isAllBreake as isAllBreak,
						osb.isFullBell,
						COALESCE(
							(
								SELECT MAX(osp.playDate)
								FROM ongeki_score_playlog osp
								WHERE osp.user = osb.user
									AND osp.musicId = osb.musicId
									AND osp.level = osb.level
									AND osp.techScore = osb.techScoreMax
							),
							(
								SELECT MAX(opd.lastPlayDate)
								FROM ongeki_profile_data opd
								WHERE opd.user = osb.user
							)
						) as playDate
					FROM ongeki_score_best osb
					WHERE osb.musicId = ?
						AND osb.level = ?
						AND osb.techScoreMax > 0
					ORDER BY osb.techScoreMax DESC
					LIMIT ?
				`,
				[musicId, chartId, limit]
			)

			const [chartInfo] = await db.execute<(DB.OngekiStaticMusic & RowDataPacket)[]>(
				`
					SELECT
						m.level,
						title,
						artist,
						jacketPath
					FROM ongeki_static_music m
					INNER JOIN (
						SELECT songId, chartId, MAX(version) AS latest_version
						FROM ongeki_static_music
						WHERE version <= ?
						GROUP BY songId, chartId
					) sv
						ON m.songId = sv.songId
						AND m.chartId = sv.chartId
						AND m.version = sv.latest_version
					WHERE m.songId = ? AND m.chartId = ?
				`,
				[version, musicId, chartId]
			)

			return c.json({
				song: chartInfo[0] || null,
				chart: chartInfo[0] ? { level: chartInfo[0].level } : null,
				leaderboard: results,
				total: results.length
			})
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch score leaderboard", error)
		}
	}
)

export { OngekiScoreLeaderboardRoutes }
