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
	isAllJustice: number
	playDate: string
}

const ChunithmScoreLeaderboardRoutes = new Hono().get(
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
			const { musicId, chartId } = c.req.param()
			const queryParams = c.req.valid("query")
			const limit = Math.min(queryParams.limit || 100, 500)

			const [results] = await db.execute<(LeaderboardEntry & RowDataPacket)[]>(
				`
					SELECT
						csb.user as userId,
						COALESCE(
							(
								SELECT cpd.userName
								FROM chuni_profile_data cpd
								WHERE cpd.user = csb.user
								ORDER BY cpd.version DESC
								LIMIT 1
							),
							'Player'
						) as username,
						csb.scoreMax as score,
						csb.scoreRank as rank,
						csb.isFullCombo,
						csb.isAllJustice,
						COALESCE(
							(
								SELECT MAX(csp.userPlayDate)
								FROM chuni_score_playlog csp
								WHERE csp.user = csb.user
									AND csp.musicId = csb.musicId
									AND csp.level = csb.level
									AND csp.score = csb.scoreMax
							),
							(
								SELECT MAX(cpd.lastPlayDate)
								FROM chuni_profile_data cpd
								WHERE cpd.user = csb.user
							)
						) as playDate
					FROM chuni_score_best csb
					WHERE csb.musicId = ?
						AND csb.level = ?
						AND csb.scoreMax > 0
					ORDER BY csb.scoreMax DESC
					LIMIT ?
				`,
				[musicId, chartId, limit]
			)

			const [songInfo] = await db.execute<(DB.ChuniStaticMusic & RowDataPacket)[]>(
				`
					SELECT
						title,
						artist,
						jacketPath
					FROM chuni_static_music
					WHERE songId = ?
					LIMIT 1
				`,
				[musicId]
			)

			const [chartInfo] = await db.execute<(DB.ChuniStaticMusic & RowDataPacket)[]>(
				`
					SELECT
						level
					FROM chuni_static_music
					WHERE songId = ? AND chartId = ?
					LIMIT 1
				`,
				[musicId, chartId]
			)

			return c.json({
				song: songInfo[0] || null,
				chart: chartInfo[0] || null,
				leaderboard: results,
				total: results.length
			})
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch score leaderboard", error)
		}
	}
)

export { ChunithmScoreLeaderboardRoutes }
