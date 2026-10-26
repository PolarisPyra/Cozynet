import { Hono } from "hono"
import { DateTime } from "luxon"
import type { RowDataPacket } from "mysql2"
import type { ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { z } from "zod"

import { calculateChunithmRating } from "@/app/shared/utils/chunithm"
import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"
import type { DB } from "@/app/shared/types"

const TACHI_CLASSES = [undefined, "DAN_I", "DAN_II", "DAN_III", "DAN_IV", "DAN_V", "DAN_INFINITE"] as const
const TACHI_DIFFICULTIES = ["BASIC", "ADVANCED", "EXPERT", "MASTER", "ULTIMA"] as const
const IMPORT_CLEAR_LAMP_TO_SKILL_ID: Partial<Record<BatchManualClearLamp, number>> = {
	HARD: 103003,
	BRAVE: 103005,
	ABSOLUTE: 103006,
	CATASTROPHY: 103007
}
const VERSION_TO_ROM_VERSION: Record<number, string> = {
	1: "10500",
	2: "11000",
	3: "11500",
	4: "12000",
	5: "12500",
	6: "13000",
	7: "13500",
	8: "14000",
	9: "14500",
	10: "15000",
	11: "20000",
	12: "20500",
	13: "21000",
	14: "21500",
	15: "22000",
	16: "22500",
	17: "23000",
	18: "24000"
}

type BatchManualClearLamp = "CATASTROPHY" | "ABSOLUTE" | "BRAVE" | "HARD" | "CLEAR" | "FAILED"
type BatchManualNoteLamp = "ALL JUSTICE CRITICAL" | "ALL JUSTICE" | "FULL COMBO" | "NONE"
interface BatchManualScore {
	identifier: string
	matchType: "inGameID"
	score: number
	noteLamp: BatchManualNoteLamp
	clearLamp: BatchManualClearLamp
	difficulty: "BASIC" | "ADVANCED" | "EXPERT" | "MASTER" | "ULTIMA"
	timeAchieved?: number
	judgements?: {
		jcrit: number
		justice: number
		attack: number
		miss: number
	}
	optional?: {
		maxCombo: number
	}
}
interface BatchManualImport {
	meta: {
		game: string
		playtype: string
		service: string
	}
	scores: BatchManualScore[]
	classes?: {
		dan?: string
		emblem?: string
	}
}

type ExistingImportedScoreRow = RowDataPacket & {
	musicId: number
	level: number
	score: number
	timeAchieved: number | null
}

type ProfileRow = RowDataPacket & {
	classEmblemBase: number | null
	classEmblemMedal: number | null
}

type ExportPlaylogRow = RowDataPacket & {
	userPlayDate: string | null
	romVersion: string | null
	musicId: number | null
	level: number | null
	score: number | null
	maxCombo: number | null
	judgeGuilty: number | null
	judgeAttack: number | null
	judgeJustice: number | null
	judgeCritical: number | null
	judgeHeaven: number | null
	isFullCombo: number | null
	isAllJustice: number | null
	isClear: number | null
	skillCategoryId: number | null
}

type BestUpsertData = {
	musicId: number
	level: number
	playCount: number
	scoreMax: number
	missCount: number | null
	maxComboCount: number | null
	isFullCombo: number
	isAllJustice: number
	isSuccess: number
	scoreRank: number
}

type ImportInsertRow = [
	userId: number,
	musicId: number,
	level: number,
	score: number,
	maxCombo: number | null,
	judgeGuilty: number | null,
	judgeAttack: number | null,
	judgeJustice: number | null,
	judgeCritical: number | null,
	judgeHeaven: number,
	isFullCombo: number,
	isAllJustice: number,
	isClear: number,
	skillId: number | null,
	fullChainKind: number,
	playerRating: number,
	userPlayDate: string,
	playDate: string,
	romVersion: string
]

type BestUpsertRow = [
	userId: number,
	musicId: number,
	level: number,
	playCount: number,
	scoreMax: number,
	missCount: number | null,
	maxComboCount: number | null,
	isFullCombo: number,
	isAllJustice: number,
	isSuccess: number,
	scoreRank: number
]

type ExecutableConnection = PoolConnection & {
	execute: <T = unknown>(sql: string, values?: unknown[]) => Promise<[T, unknown]>
}

const ImportScoreSchema = z.object({
	songId: z.number().int().nonnegative(),
	level: z.number().int().min(0).max(4),
	score: z.number().int().min(0).max(1010000),
	noteLamp: z.enum(["ALL JUSTICE CRITICAL", "ALL JUSTICE", "FULL COMBO", "NONE"]),
	clearLamp: z.enum(["CATASTROPHY", "ABSOLUTE", "BRAVE", "HARD", "CLEAR", "FAILED"]),
	timeAchieved: z.number().int().nonnegative().optional(),
	judgements: z
		.object({
			jcrit: z.number().int().min(0),
			justice: z.number().int().min(0),
			attack: z.number().int().min(0),
			miss: z.number().int().min(0)
		})
		.optional(),
	maxCombo: z.number().int().min(0).optional()
})

const ImportRequestSchema = z.object({
	scores: z.array(ImportScoreSchema).min(1)
})

const getImportedPlayDate = (timeAchieved?: number) => {
	if (!timeAchieved) {
		return DateTime.now().setZone("Asia/Tokyo").toFormat("yyyy-LL-dd HH:mm:ss")
	}

	return DateTime.fromMillis(timeAchieved, { zone: "utc" }).setZone("Asia/Tokyo").toFormat("yyyy-LL-dd HH:mm:ss")
}

// Keeps multi-row inserts under MySQL's prepared statement placeholder limit
const IMPORT_CHUNK_SIZE = 1000
const chunkRows = <T>(rows: T[]) => {
	const chunks: T[][] = []
	for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) chunks.push(rows.slice(i, i + IMPORT_CHUNK_SIZE))
	return chunks
}

const getExistingScoreKey = (score: { musicId: number; level: number; score: number; timeAchieved: number | null }) =>
	`${score.musicId}:${score.level}:${score.score}:${score.timeAchieved ?? 0}`

const getChunithmScoreRank = (score: number) => {
	if (score >= 1009000) return 13
	if (score >= 1007500) return 12
	if (score >= 1005000) return 11
	if (score >= 1000000) return 10
	if (score >= 990000) return 9
	if (score >= 975000) return 8
	if (score >= 950000) return 7
	if (score >= 925000) return 6
	if (score >= 900000) return 5
	if (score >= 800000) return 4
	if (score >= 700000) return 3
	if (score >= 600000) return 2
	if (score >= 500000) return 1
	return 0
}

const mergeChunithmBest = (current: BestUpsertData | undefined, next: BestUpsertData) => {
	if (!current) {
		return next
	}

	return {
		...current,
		playCount: Math.max(current.playCount, next.playCount),
		scoreMax: Math.max(current.scoreMax, next.scoreMax),
		scoreRank: getChunithmScoreRank(Math.max(current.scoreMax, next.scoreMax)),
		missCount:
			current.missCount === null
				? next.missCount
				: next.missCount === null
					? current.missCount
					: Math.min(current.missCount, next.missCount),
		maxComboCount: Math.max(current.maxComboCount ?? 0, next.maxComboCount ?? 0),
		isFullCombo: Math.max(current.isFullCombo, next.isFullCombo),
		isAllJustice: Math.max(current.isAllJustice, next.isAllJustice),
		isSuccess: Math.max(current.isSuccess, next.isSuccess)
	}
}

const ChunithmKamaitachiRoutes = new Hono()
	.get("export", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.chunithm_version

			const [profileResults] = await db.execute<ProfileRow[]>(
				`SELECT classEmblemBase, classEmblemMedal
       FROM chuni_profile_data
       WHERE user = ? AND version = ?`,
				[userId, version]
			)

			const profile = profileResults.length > 0 ? profileResults[0] : null

			const [playlogResults] = await db.execute<ExportPlaylogRow[]>(
				`SELECT
				p.userPlayDate as userPlayDate,
				p.romVersion,
				p.musicId,
				p.level,
				p.score,
				p.maxCombo,
				p.judgeGuilty,
				p.judgeAttack,
				p.judgeJustice,
				p.judgeCritical,
				p.judgeHeaven,
				p.isFullCombo,
				p.isAllJustice,
				p.isClear,
				s.categoryId AS skillCategoryId
			FROM chuni_score_playlog p
			LEFT JOIN cozynet_static_chuni_skill s ON s.skillId = p.skillId
			WHERE p.user = ?
			GROUP BY p.id
			ORDER BY userPlayDate DESC`,
				[userId]
			)

			const tachiExport: BatchManualImport = {
				meta: {
					game: "chunithm",
					playtype: "Single",
					service: "Cozynet"
				},
				scores: [],
				classes: {
					dan: TACHI_CLASSES[profile?.classEmblemBase ?? 0],
					emblem: TACHI_CLASSES[profile?.classEmblemMedal ?? 0]
				}
			}

			for (const log of playlogResults) {
				const {
					userPlayDate,
					romVersion,
					musicId,
					level,
					score,
					judgeHeaven,
					judgeCritical,
					judgeJustice,
					judgeAttack,
					judgeGuilty,
					maxCombo,
					isAllJustice,
					isFullCombo,
					isClear,
					skillCategoryId
				} = log

				const timeAchieved = userPlayDate
					? DateTime.fromSQL(userPlayDate, { zone: "Asia/Tokyo" }).toMillis()
					: undefined

				if (
					romVersion === null ||
					musicId === null ||
					level === null ||
					score === null ||
					judgeJustice === null ||
					isAllJustice === null ||
					isFullCombo === null ||
					isClear === null
				) {
					continue
				}

				// Filter out WORLD'S END scores
				if (romVersion.startsWith("1.") && level === 4) {
					continue
				}

				if (romVersion.startsWith("2.") && level === 5) {
					continue
				}

				let noteLamp: BatchManualNoteLamp = "NONE"
				let clearLamp: BatchManualClearLamp = "FAILED"

				if (isAllJustice && score === 1_010_000) {
					noteLamp = "ALL JUSTICE CRITICAL"
				} else if (isAllJustice) {
					noteLamp = "ALL JUSTICE"
				} else if (isFullCombo) {
					noteLamp = "FULL COMBO"
				}

				if (isClear) {
					if (skillCategoryId === 10) {
						clearLamp = "CATASTROPHY"
					} else if (skillCategoryId === 9) {
						clearLamp = "ABSOLUTE"
					} else if (skillCategoryId === 16) {
						clearLamp = "BRAVE"
					} else if (skillCategoryId === 6 || skillCategoryId === 7 || skillCategoryId === 15) {
						clearLamp = "HARD"
					} else {
						clearLamp = "CLEAR"
					}
				}

				const tachiScore: BatchManualScore = {
					score,
					noteLamp,
					clearLamp,
					identifier: musicId.toString(),
					matchType: "inGameID",
					difficulty: TACHI_DIFFICULTIES[level],
					timeAchieved: timeAchieved != null ? Number(timeAchieved) : undefined
				}

				if (judgeCritical !== null && judgeJustice !== null && judgeAttack !== null && judgeGuilty !== null) {
					tachiScore.judgements = {
						jcrit: (judgeHeaven ?? 0) + judgeCritical,
						justice: judgeJustice,
						attack: judgeAttack,
						miss: judgeGuilty
					}
				}

				if (maxCombo !== null) {
					tachiScore.optional = {
						maxCombo
					}
				}

				tachiExport.scores.push(tachiScore)
			}

			return c.json(tachiExport)
		} catch (error) {
			throw rethrowWithMessage("Failed to export data", error)
		}
	})
	.post("import", validateJson(ImportRequestSchema), async c => {
		const conn = (await db.getConnection()) as ExecutableConnection
		try {
			const { userId, versions } = c.payload
			const { scores } = c.req.valid("json")
			const version = versions.chunithm_version
			const romVersion = VERSION_TO_ROM_VERSION[version] ?? VERSION_TO_ROM_VERSION[18]

			const songIds = [...new Set(scores.map(score => score.songId))]

			// Get levels for all songs to calculate ratings
			const [staticRows] = await db.execute<(DB.ChuniStaticMusic & RowDataPacket)[]>(
				`SELECT songId, chartId, level as chartLevel
				FROM chuni_static_music
				WHERE songId IN (${songIds.map(() => "?").join(",")})
				GROUP BY songId, chartId`,
				songIds
			)

			const songLevelsMap = new Map<string, { chartLevel: number }>(
				staticRows.map(row => [`${row.songId}:${row.chartId}`, { chartLevel: row.chartLevel }])
			)

			const [existingRows] = await conn.execute<ExistingImportedScoreRow[]>(
				`SELECT
					musicId,
					level,
					score,
					UNIX_TIMESTAMP(userPlayDate) * 1000 AS timeAchieved
				FROM chuni_score_playlog
				WHERE user = ?
					AND musicId IN (${songIds.map(() => "?").join(", ")})`,
				[userId, ...songIds]
			)

			const existingKeys = new Set(existingRows.map(getExistingScoreKey))
			const seenImportKeys = new Set<string>()
			const rowsToInsert: ImportInsertRow[] = []
			const bestByChart = new Map<string, BestUpsertData>()
			let duplicateCount = 0
			let missingSongCount = 0

			for (const score of scores) {
				const playDate = getImportedPlayDate(score.timeAchieved)
				const duplicateKey = `${score.songId}:${score.level}:${score.score}:${score.timeAchieved ?? 0}`
				const song = songLevelsMap.get(`${score.songId}:${score.level}`)

				if (!song) {
					missingSongCount += 1
					continue
				}

				const isAllJustice = score.noteLamp === "ALL JUSTICE" || score.noteLamp === "ALL JUSTICE CRITICAL" ? 1 : 0
				const isFullCombo = isAllJustice === 1 || score.noteLamp === "FULL COMBO" ? 1 : 0
				const isClear = score.clearLamp === "FAILED" ? 0 : 1
				const skillId = IMPORT_CLEAR_LAMP_TO_SKILL_ID[score.clearLamp] ?? null
				const chartLevel = song?.chartLevel ?? 0
				const playerRating = Math.floor(calculateChunithmRating(chartLevel, score.score) * 100)

				const bestKey = `${score.songId}:${score.level}`
				bestByChart.set(
					bestKey,
					mergeChunithmBest(bestByChart.get(bestKey), {
						musicId: score.songId,
						level: score.level,
						playCount: 1,
						scoreMax: score.score,
						missCount: score.judgements?.miss ?? null,
						maxComboCount: score.maxCombo ?? null,
						isFullCombo,
						isAllJustice,
						isSuccess: isClear,
						scoreRank: getChunithmScoreRank(score.score)
					})
				)

				if (existingKeys.has(duplicateKey) || seenImportKeys.has(duplicateKey)) {
					duplicateCount += 1
					continue
				}

				seenImportKeys.add(duplicateKey)

				rowsToInsert.push([
					userId,
					score.songId,
					score.level,
					score.score,
					score.maxCombo ?? null,
					score.judgements?.miss ?? null,
					score.judgements?.attack ?? null,
					score.judgements?.justice ?? null,
					score.judgements?.jcrit ?? null,
					0,
					isFullCombo,
					isAllJustice,
					isClear,
					skillId,
					0,
					playerRating,
					playDate,
					playDate,
					romVersion
				])
			}

			const rowsToUpsertBest: BestUpsertRow[] = [...bestByChart.values()].map(best => [
				userId,
				best.musicId,
				best.level,
				best.playCount,
				best.scoreMax,
				best.missCount,
				best.maxComboCount,
				best.isFullCombo,
				best.isAllJustice,
				best.isSuccess,
				best.scoreRank
			])

			if (rowsToInsert.length === 0 && rowsToUpsertBest.length === 0) {
				return c.json({
					importedCount: 0,
					bestUpdatedCount: 0,
					duplicateCount,
					missingSongCount,
					skippedCount: duplicateCount + missingSongCount
				})
			}

			await conn.beginTransaction()

			let importedCount = 0

			for (const chunk of chunkRows(rowsToInsert)) {
				const valuePlaceholders = chunk
					.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
					.join(", ")

				const [result] = await conn.execute<ResultSetHeader>(
					`INSERT INTO chuni_score_playlog (
					user,
					musicId,
					level,
					score,
					maxCombo,
					judgeGuilty,
					judgeAttack,
					judgeJustice,
					judgeCritical,
					judgeHeaven,
					isFullCombo,
					isAllJustice,
					isClear,
					skillId,
					fullChainKind,
					playerRating,
					userPlayDate,
					playDate,
					romVersion
				) VALUES ${valuePlaceholders}`,
					chunk.flat()
				)

				importedCount += result.affectedRows
			}

			let bestUpdatedCount = 0

			for (const chunk of chunkRows(rowsToUpsertBest)) {
				const bestValuePlaceholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")

				await conn.execute<ResultSetHeader>(
					`INSERT INTO chuni_score_best (
						user,
						musicId,
						level,
						playCount,
						scoreMax,
						missCount,
						maxComboCount,
						isFullCombo,
						isAllJustice,
						isSuccess,
						scoreRank
					) VALUES ${bestValuePlaceholders}
					ON DUPLICATE KEY UPDATE
						playCount = GREATEST(COALESCE(chuni_score_best.playCount, 0), VALUES(playCount)),
						scoreRank = IF(VALUES(scoreMax) > COALESCE(chuni_score_best.scoreMax, 0), VALUES(scoreRank), chuni_score_best.scoreRank),
						scoreMax = GREATEST(COALESCE(chuni_score_best.scoreMax, 0), VALUES(scoreMax)),
						missCount = CASE
							WHEN chuni_score_best.missCount IS NULL THEN VALUES(missCount)
							WHEN VALUES(missCount) IS NULL THEN chuni_score_best.missCount
							ELSE LEAST(chuni_score_best.missCount, VALUES(missCount))
						END,
						maxComboCount = GREATEST(COALESCE(chuni_score_best.maxComboCount, 0), COALESCE(VALUES(maxComboCount), 0)),
						isFullCombo = GREATEST(COALESCE(chuni_score_best.isFullCombo, 0), VALUES(isFullCombo)),
						isAllJustice = GREATEST(COALESCE(chuni_score_best.isAllJustice, 0), VALUES(isAllJustice)),
						isSuccess = GREATEST(COALESCE(chuni_score_best.isSuccess, 0), VALUES(isSuccess))`,
					chunk.flat()
				)

				bestUpdatedCount += chunk.length
			}

			await conn.commit()

			return c.json({
				importedCount,
				bestUpdatedCount,
				duplicateCount,
				missingSongCount,
				skippedCount: duplicateCount + missingSongCount
			})
		} catch (error) {
			await conn.rollback()
			throw rethrowWithMessage("Failed to import data", error)
		} finally {
			conn.release()
		}
	})

export { ChunithmKamaitachiRoutes as ChunithmScoreExporterRoutes }
