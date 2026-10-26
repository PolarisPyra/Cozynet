import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"
import { DB } from "@/app/shared/types"

const ChunithmOptionsRoutes = new Hono()
	.get("/", async c => {
		try {
			const userId = c.payload.userId
			if (!userId) throw new HTTPException(403)

			const [rows] = await db.execute<(DB.ChuniProfileOption & RowDataPacket)[]>(
				"SELECT * FROM chuni_profile_option WHERE user = ?",
				[userId]
			)

			if (rows.length === 0) {
				// Return default options if none exist
				const defaultOptions: DB.ChuniProfileOption = {
					id: 0,
					user: userId,
					speed: 0,
					bgInfo: 0,
					rating: 0,
					privacy: 0,
					judgePos: 0,
					matching: 0,
					guideLine: 0,
					headphone: 0,
					optionSet: 0,
					fieldColor: 0,
					guideSound: 0,
					successAir: 0,
					successTap: 0,
					judgeAttack: 0,
					playerLevel: 0,
					soundEffect: 0,
					judgeJustice: 0,
					successExTap: 0,
					successFlick: 0,
					successSkill: 0,
					successSlideHold: 0,
					successTapTimbre: 0,
					ext1: 0,
					ext2: 0,
					ext3: 0,
					ext4: 0,
					ext5: 0,
					ext6: 0,
					ext7: 0,
					ext8: 0,
					ext9: 0,
					ext10: 0,
					categoryDetail: 0,
					judgeTimingOffset_120: 0,
					resultVoiceShort: 0,
					judgeAppendSe: 0,
					judgeCritical: 0,
					trackSkip: 0,
					selectMusicFilterLv: 0,
					sortMusicFilterLv: 0,
					sortMusicGenre: 0,
					speed_120: 0,
					judgeTimingOffset: 0,
					mirrorFumen: 0,
					playTimingOffset_120: 0,
					hardJudge: 0,
					notesThickness: 0,
					fieldWallPosition: 0,
					playTimingOffset: 0,
					fieldWallPosition_120: 0
				}
				return c.json(defaultOptions)
			}

			return c.json(rows[0])
		} catch (error) {
			throw rethrowWithMessage("Failed to get game options", error)
		}
	})
	.post(
		"/update",
		validateJson(
			z.object({
				speed: z.number().optional(),
				speed_120: z.number().optional(),
				mirrorFumen: z.number().optional(),
				trackSkip: z.number().optional(),
				judgeTimingOffset: z.number().optional(),
				judgeTimingOffset_120: z.number().optional(),
				playTimingOffset: z.number().optional(),
				playTimingOffset_120: z.number().optional(),
				matching: z.number().optional(),
				playerLevel: z.number().optional(),
				rating: z.number().optional(),
				categoryDetail: z.number().optional(),
				guideSound: z.number().optional(),
				successTapTimbre: z.number().optional(),
				successTap: z.number().optional(),
				successExTap: z.number().optional(),
				successSlideHold: z.number().optional(),
				successAir: z.number().optional(),
				successFlick: z.number().optional(),
				successSkill: z.number().optional(),
				judgeAppendSe: z.number().optional(),
				judgePos: z.number().optional(),
				judgeCritical: z.number().optional(),
				judgeJustice: z.number().optional(),
				judgeAttack: z.number().optional(),
				guideLine: z.number().optional(),
				fieldColor: z.number().optional(),
				fieldWallPosition: z.number().optional(),
				fieldWallPosition_120: z.number().optional(),
				bgInfo: z.number().optional()
			})
		),
		async c => {
			try {
				const userId = c.payload.userId
				if (!userId) throw new HTTPException(403)

				const options = c.req.valid("json")

				// Check if user has existing options
				const [existing] = await db.execute<RowDataPacket[]>("SELECT id FROM chuni_profile_option WHERE user = ?", [
					userId
				])

				if (existing.length > 0) {
					// Update existing record, keeping fields that were not provided
					const [result] = await db.execute<ResultSetHeader>(
						`UPDATE chuni_profile_option SET
							speed = COALESCE(?, speed), speed_120 = COALESCE(?, speed_120), mirrorFumen = COALESCE(?, mirrorFumen), trackSkip = COALESCE(?, trackSkip),
							judgeTimingOffset = COALESCE(?, judgeTimingOffset), judgeTimingOffset_120 = COALESCE(?, judgeTimingOffset_120), playTimingOffset = COALESCE(?, playTimingOffset), playTimingOffset_120 = COALESCE(?, playTimingOffset_120),
							matching = COALESCE(?, matching), playerLevel = COALESCE(?, playerLevel), rating = COALESCE(?, rating), categoryDetail = COALESCE(?, categoryDetail),
							guideSound = COALESCE(?, guideSound), successTapTimbre = COALESCE(?, successTapTimbre), successTap = COALESCE(?, successTap), successExTap = COALESCE(?, successExTap),
							successSlideHold = COALESCE(?, successSlideHold), successAir = COALESCE(?, successAir), successFlick = COALESCE(?, successFlick), successSkill = COALESCE(?, successSkill),
							judgeAppendSe = COALESCE(?, judgeAppendSe), judgePos = COALESCE(?, judgePos), judgeCritical = COALESCE(?, judgeCritical), judgeJustice = COALESCE(?, judgeJustice),
							judgeAttack = COALESCE(?, judgeAttack), guideLine = COALESCE(?, guideLine), fieldColor = COALESCE(?, fieldColor), fieldWallPosition = COALESCE(?, fieldWallPosition),
							fieldWallPosition_120 = COALESCE(?, fieldWallPosition_120), bgInfo = COALESCE(?, bgInfo)
							WHERE user = ?`,
						[
							options.speed ?? null,
							options.speed_120 ?? null,
							options.mirrorFumen ?? null,
							options.trackSkip ?? null,
							options.judgeTimingOffset ?? null,
							options.judgeTimingOffset_120 ?? null,
							options.playTimingOffset ?? null,
							options.playTimingOffset_120 ?? null,
							options.matching ?? null,
							options.playerLevel ?? null,
							options.rating ?? null,
							options.categoryDetail ?? null,
							options.guideSound ?? null,
							options.successTapTimbre ?? null,
							options.successTap ?? null,
							options.successExTap ?? null,
							options.successSlideHold ?? null,
							options.successAir ?? null,
							options.successFlick ?? null,
							options.successSkill ?? null,
							options.judgeAppendSe ?? null,
							options.judgePos ?? null,
							options.judgeCritical ?? null,
							options.judgeJustice ?? null,
							options.judgeAttack ?? null,
							options.guideLine ?? null,
							options.fieldColor ?? null,
							options.fieldWallPosition ?? null,
							options.fieldWallPosition_120 ?? null,
							options.bgInfo ?? null,
							userId
						]
					)
					return c.json(result)
				} else {
					// Insert new record
					const [result] = await db.execute<ResultSetHeader>(
						`INSERT INTO chuni_profile_option (
							user, speed, speed_120, mirrorFumen, trackSkip,
							judgeTimingOffset, judgeTimingOffset_120, playTimingOffset, playTimingOffset_120,
							matching, playerLevel, rating, categoryDetail,
							guideSound, successTapTimbre, successTap, successExTap,
							successSlideHold, successAir, successFlick, successSkill,
							judgeAppendSe, judgePos, judgeCritical, judgeJustice,
							judgeAttack, guideLine, fieldColor, fieldWallPosition,
							fieldWallPosition_120, bgInfo
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[
							userId,
							options.speed ?? null,
							options.speed_120 ?? null,
							options.mirrorFumen ?? null,
							options.trackSkip ?? null,
							options.judgeTimingOffset ?? null,
							options.judgeTimingOffset_120 ?? null,
							options.playTimingOffset ?? null,
							options.playTimingOffset_120 ?? null,
							options.matching ?? null,
							options.playerLevel ?? null,
							options.rating ?? null,
							options.categoryDetail ?? null,
							options.guideSound ?? null,
							options.successTapTimbre ?? null,
							options.successTap ?? null,
							options.successExTap ?? null,
							options.successSlideHold ?? null,
							options.successAir ?? null,
							options.successFlick ?? null,
							options.successSkill ?? null,
							options.judgeAppendSe ?? null,
							options.judgePos ?? null,
							options.judgeCritical ?? null,
							options.judgeJustice ?? null,
							options.judgeAttack ?? null,
							options.guideLine ?? null,
							options.fieldColor ?? null,
							options.fieldWallPosition ?? null,
							options.fieldWallPosition_120 ?? null,
							options.bgInfo ?? null
						]
					)
					return c.json(result)
				}
			} catch (error) {
				throw rethrowWithMessage("Failed to update game options", error)
			}
		}
	)

export { ChunithmOptionsRoutes }
