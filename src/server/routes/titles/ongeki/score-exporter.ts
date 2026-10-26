import { Hono } from "hono"
import { DateTime } from "luxon"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { z } from "zod"

import type { DB } from "@/app/shared/types"
import { calculateOngekiGekForceRating, calculateOngekiRating } from "@/app/shared/utils/ongeki"
import { db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

const TACHI_CLASSES = [undefined, "DAN_I", "DAN_II", "DAN_III", "DAN_IV", "DAN_V", "DAN_INFINITE"] as const
const TACHI_DIFFICULTIES = ["BASIC", "ADVANCED", "EXPERT", "MASTER", "LUNATIC"] as const

type BatchManualNoteLamp = "LOSS" | "CLEAR" | "FULL COMBO" | "ALL BREAK" | "ALL BREAK+"
type BatchManualBellLamp = "NONE" | "FULL BELL"
interface BatchManualScore {
	identifier: string
	matchType: "inGameID"
	score: number
	noteLamp: BatchManualNoteLamp
	bellLamp: BatchManualBellLamp
	platinumScore: number
	difficulty: "BASIC" | "ADVANCED" | "EXPERT" | "MASTER" | "LUNATIC"
	timeAchieved?: number
	judgements?: {
		cbreak: number
		break: number
		hit: number
		miss: number
	}
	optional?: {
		maxCombo?: number
		fast?: number
		slow?: number
		damage?: number
		bellCount?: number
		totalBellCount?: number
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
	}
}

type ProfileRow = RowDataPacket & {
	playerRating: number | null
}

type ExportPlaylogRow = RowDataPacket & {
	userPlayDate: string | null
	musicId: number | null
	level: number | null
	techScore: number | null
	maxCombo: number | null
	judgeCriticalBreak: number | null
	judgeBreak: number | null
	judgeHit: number | null
	judgeMiss: number | null
	bellCount: number | null
	totalBellCount: number | null
	damageCount: number | null
	isFullBell: number | null
	isFullCombo: number | null
	isAllBreak: number | null
	clearStatus: number | null
	platinumScore: number | null
}

interface ExistingImportedScoreRow extends RowDataPacket {
	musicId: number
	level: number
	techScore: number
	timeAchieved: number
}

type ExistingBestScoreRow = RowDataPacket & {
	musicId: number
	level: number
	techScoreMax: number | null
	maxComboCount: number | null
	isFullBell: number | null
	isFullCombo: number | null
	isAllBreake: number | null
	clearStatus: number | null
	platinumScoreMax: number | null
	platinumScoreStar: number | null
}

type BestUpsertData = {
	musicId: number
	level: number
	playCount: number
	techScoreMax: number
	techScoreRank: number
	maxComboCount: number
	isFullBell: number
	isFullCombo: number
	isAllBreake: number
	clearStatus: number
	platinumScoreMax: number | null
	platinumScoreStar: number | null
}

type ImportInsertRow = [
	userId: number,
	musicId: number,
	level: number,
	clearStatus: number,
	techScore: number,
	maxCombo: number | null,
	judgeMiss: number | null,
	judgeHit: number | null,
	judgeBreak: number | null,
	judgeCriticalBreak: number | null,
	bellCount: number | null,
	totalBellCount: number | null,
	damageCount: number | null,
	isFullCombo: number,
	isFullBell: number,
	isAllBreak: number,
	playerRating: number,
	platinumScore: number | null,
	platinumScoreMax: number | null,
	platinumScoreStar: number | null,
	userPlayDate: string,
	playDate: string,
	version: number
]

type BestUpsertRow = [
	userId: number,
	musicId: number,
	level: number,
	playCount: number,
	techScoreMax: number,
	techScoreRank: number,
	maxComboCount: number,
	isFullBell: number,
	isFullCombo: number,
	isAllBreake: number,
	clearStatus: number,
	platinumScoreMax: number | null,
	platinumScoreStar: number | null
]

type ExecutableConnection = PoolConnection & {
	execute: <T = unknown>(sql: string, values?: unknown[]) => Promise<[T, unknown]>
}

const normalizeNullableNumber = (value: unknown) => (value === null || value === undefined ? undefined : value)

const normalizeOptionalJudgements = (value: unknown) => {
	if (!value || typeof value !== "object") {
		return undefined
	}

	const judgementRecord = value as Partial<Record<"cbreak" | "break" | "hit" | "miss", unknown>>
	const requiredKeys = ["cbreak", "break", "hit", "miss"] as const

	// Older Kamai exports can send an empty judgements object. Treat that the same
	// as a missing optional field so validation does not reject the entire import.
	return requiredKeys.every(key => typeof judgementRecord[key] === "number") ? judgementRecord : undefined
}

const ImportScoreSchema = z.object({
	songId: z.number().int().nonnegative(),
	level: z.union([z.number().int().min(0).max(3), z.literal(10)]),
	score: z.number().int().min(0).max(1010000),
	noteLamp: z.enum(["LOSS", "CLEAR", "FULL COMBO", "ALL BREAK", "ALL BREAK+"]),
	bellLamp: z.enum(["NONE", "FULL BELL"]),
	platinumScore: z.number().int().min(0).nullable().optional(),
	platinumScoreMax: z.number().int().min(0).nullable().optional(),
	platinumStars: z.number().int().min(0).nullable().optional(),
	// Kamai can emit null here; normalize it away so the field stays truly optional.
	timeAchieved: z.preprocess(normalizeNullableNumber, z.number().int().nonnegative().optional()),
	judgements: z.preprocess(
		normalizeOptionalJudgements,
		z
			.object({
				cbreak: z.number().int().min(0),
				break: z.number().int().min(0),
				hit: z.number().int().min(0),
				miss: z.number().int().min(0)
			})
			.optional()
	),
	maxCombo: z.number().int().min(0).optional(),
	damage: z.number().int().min(0).nullable().optional(),
	bellCount: z.number().int().min(0).nullable().optional(),
	totalBellCount: z.number().int().min(0).nullable().optional()
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

const getExistingScoreKey = (score: ExistingImportedScoreRow) => `${score.musicId}:${score.level}:${score.techScore}`

const getOngekiTechScoreRank = (score: number) => {
	if (score >= 1007500) return 12
	if (score >= 1000000) return 11
	if (score >= 990000) return 10
	if (score >= 970000) return 9
	if (score >= 940000) return 8
	if (score >= 900000) return 7
	if (score >= 850000) return 6
	if (score >= 800000) return 5
	if (score >= 750000) return 4
	if (score >= 700000) return 3
	if (score >= 500000) return 2
	return 0
}

const maxNullableNumber = (left: number | null, right: number | null) => {
	if (left === null) return right
	if (right === null) return left
	return Math.max(left, right)
}

const maxNullableZeroNumber = (left: number | null, right: number | null) => Math.max(left ?? 0, right ?? 0)

const isOngekiBestUpdate = (current: ExistingBestScoreRow | undefined, next: BestUpsertData) => {
	if (!current || current.techScoreMax == null) return true
	if (next.techScoreMax > current.techScoreMax) return true
	if (next.maxComboCount > (current.maxComboCount ?? 0)) return true
	if (next.isFullBell > (current.isFullBell ?? 0)) return true
	if (next.isFullCombo > (current.isFullCombo ?? 0)) return true
	if (next.isAllBreake > (current.isAllBreake ?? 0)) return true
	if (next.clearStatus > (current.clearStatus ?? 0)) return true
	if (
		next.platinumScoreMax != null &&
		(current.platinumScoreMax == null || next.platinumScoreMax > current.platinumScoreMax)
	) {
		return true
	}
	if (next.platinumScoreStar != null && next.platinumScoreStar > (current.platinumScoreStar ?? 0)) return true

	return false
}

const mergeOngekiBest = (current: BestUpsertData | undefined, next: BestUpsertData) => {
	if (!current) {
		return next
	}

	const techScoreMax = Math.max(current.techScoreMax, next.techScoreMax)

	return {
		...current,
		playCount: Math.max(current.playCount, next.playCount),
		techScoreMax,
		techScoreRank: getOngekiTechScoreRank(techScoreMax),
		maxComboCount: Math.max(current.maxComboCount, next.maxComboCount),
		isFullBell: Math.max(current.isFullBell, next.isFullBell),
		isFullCombo: Math.max(current.isFullCombo, next.isFullCombo),
		isAllBreake: Math.max(current.isAllBreake, next.isAllBreake),
		clearStatus: Math.max(current.clearStatus, next.clearStatus),
		platinumScoreMax: maxNullableNumber(current.platinumScoreMax, next.platinumScoreMax),
		platinumScoreStar: maxNullableZeroNumber(current.platinumScoreStar, next.platinumScoreStar)
	}
}

const OngekiKamaitachiRoutes = new Hono()
	.get("export", async c => {
		try {
			const { userId, versions } = c.payload
			const version = versions.ongeki_version

			const [profileResults] = await db.execute<ProfileRow[]>(
				`SELECT playerRating FROM ongeki_profile_data WHERE user = ? AND version = ?`,
				[userId, version]
			)

			const profile = profileResults.length > 0 ? profileResults[0] : null

			const [playlogResults] = await db.execute<ExportPlaylogRow[]>(
				`SELECT
				p.userPlayDate as userPlayDate,
                p.musicId,
                p.level,
                p.techScore,
                p.maxCombo,
                p.judgeCriticalBreak,
                p.judgeBreak,
                p.judgeHit,
                p.judgeMiss,
                p.bellCount,
                p.totalBellCount,
                p.damageCount,
                p.isFullBell,
                p.isFullCombo,
                p.isAllBreak,
                p.clearStatus,
				p.platinumScore
            FROM ongeki_score_playlog p
            WHERE user = ?
            GROUP BY p.id
            ORDER BY userPlayDate DESC`,
				[userId]
			)

			const tachiExport: BatchManualImport = {
				meta: {
					game: "ongeki",
					playtype: "Single",
					service: "Cozynet"
				},
				scores: [],
				classes: {
					dan: TACHI_CLASSES[Math.floor((profile?.playerRating ?? 0) / 100)]
				}
			}

			for (const log of playlogResults) {
				const {
					userPlayDate,
					musicId,
					level,
					techScore,
					maxCombo,
					judgeCriticalBreak,
					judgeBreak,
					judgeHit,
					judgeMiss,
					bellCount,
					totalBellCount,
					damageCount,
					isFullBell,
					isFullCombo,
					isAllBreak,
					clearStatus,
					platinumScore
				} = log

				const timeAchieved = userPlayDate
					? DateTime.fromSQL(userPlayDate, { zone: "Asia/Tokyo" }).toMillis()
					: undefined

				if (
					musicId === null ||
					level === null ||
					techScore === null ||
					clearStatus === null ||
					isFullBell === null ||
					isFullCombo === null ||
					isAllBreak === null
				) {
					continue
				}

				let noteLamp: BatchManualNoteLamp = "LOSS"

				// Determine note lamp based on clearStatus and achievements
				// According to Kamaitachi docs: LOSS, CLEAR, FULL COMBO, ALL BREAK, ALL BREAK+
				if (clearStatus >= 1) {
					if (isAllBreak && techScore >= 1010000) {
						noteLamp = "ALL BREAK+"
					} else if (isAllBreak) {
						noteLamp = "ALL BREAK"
					} else if (isFullCombo) {
						noteLamp = "FULL COMBO"
					} else {
						noteLamp = "CLEAR"
					}
				}

				let bellLamp: BatchManualBellLamp = "NONE"
				if (isFullBell) {
					bellLamp = "FULL BELL"
				}

				let difficulty = TACHI_DIFFICULTIES[level]
				if (level == 10) {
					difficulty = "LUNATIC"
				}

				const tachiScore: BatchManualScore = {
					score: Math.min(techScore, 1010000),
					noteLamp,
					bellLamp,
					platinumScore: platinumScore ?? 0,
					identifier: musicId.toString(),
					matchType: "inGameID",
					difficulty,
					timeAchieved
				}

				if (judgeCriticalBreak !== null && judgeBreak !== null && judgeHit !== null && judgeMiss !== null) {
					tachiScore.judgements = {
						cbreak: judgeCriticalBreak,
						break: judgeBreak,
						hit: judgeHit,
						miss: judgeMiss
					}
				}

				const optional: BatchManualScore["optional"] = {}
				if (maxCombo !== null) optional.maxCombo = maxCombo
				if (damageCount !== null) optional.damage = damageCount
				if (bellCount !== null) optional.bellCount = bellCount
				if (totalBellCount !== null) optional.totalBellCount = totalBellCount

				if (Object.keys(optional).length > 0) {
					tachiScore.optional = optional
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
			const version = versions.ongeki_version

			const songIds = [...new Set(scores.map(score => score.songId))]
			const chartIds = [...new Set(scores.map(score => score.level))]

			if (songIds.length === 0 || chartIds.length === 0) {
				return c.json({ importedCount: 0, duplicateCount: 0, missingSongCount: 0, skippedCount: 0 })
			}

			const [staticRows] = await db.execute<(DB.OngekiStaticMusic & RowDataPacket)[]>(
				`SELECT songId, chartId, level as chartLevel
				FROM ongeki_static_music
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
					techScore
				FROM ongeki_score_playlog
				WHERE user = ?
					AND musicId IN (${songIds.map(() => "?").join(",")})
					AND level IN (${chartIds.map(() => "?").join(",")})`,
				[userId, ...songIds, ...chartIds]
			)

			const existingKeys = new Set(existingRows.map(getExistingScoreKey))

			const [existingBestRows] = await conn.execute<ExistingBestScoreRow[]>(
				`SELECT
					musicId,
					level,
					techScoreMax,
					maxComboCount,
					isFullBell,
					isFullCombo,
					isAllBreake,
					clearStatus,
					platinumScoreMax,
					platinumScoreStar
				FROM ongeki_score_best
				WHERE user = ?
					AND musicId IN (${songIds.map(() => "?").join(",")})
					AND level IN (${chartIds.map(() => "?").join(",")})`,
				[userId, ...songIds, ...chartIds]
			)

			const existingBestMap = new Map(existingBestRows.map(row => [`${row.musicId}:${row.level}`, row]))
			const seenImportKeys = new Set<string>()
			const rowsToInsert: ImportInsertRow[] = []
			const bestByChart = new Map<string, BestUpsertData>()
			let duplicateCount = 0
			let missingSongCount = 0

			for (const score of scores) {
				const playDate = getImportedPlayDate(score.timeAchieved)
				const duplicateKey = `${score.songId}:${score.level}:${score.score}`
				const song = songLevelsMap.get(`${score.songId}:${score.level}`)

				if (!song) {
					missingSongCount += 1
					continue
				}

				const isAllBreak = score.noteLamp === "ALL BREAK" || score.noteLamp === "ALL BREAK+" ? 1 : 0
				const isFullCombo = isAllBreak === 1 || score.noteLamp === "FULL COMBO" ? 1 : 0
				const isFullBell = score.bellLamp === "FULL BELL" ? 1 : 0
				const clearStatus = score.noteLamp === "LOSS" ? 0 : 1
				const chartLevel = song.chartLevel ?? 0
				const playerRating =
					version >= 8
						? Math.floor(calculateOngekiGekForceRating(chartLevel, score.score, isFullCombo, isAllBreak, isFullBell))
						: Math.floor(calculateOngekiRating(chartLevel, score.score) * 100)

				const bestKey = `${score.songId}:${score.level}`
				bestByChart.set(
					bestKey,
					mergeOngekiBest(bestByChart.get(bestKey), {
						musicId: score.songId,
						level: score.level,
						playCount: 1,
						techScoreMax: score.score,
						techScoreRank: getOngekiTechScoreRank(score.score),
						maxComboCount: score.maxCombo ?? 0,
						isFullBell,
						isFullCombo,
						isAllBreake: isAllBreak,
						clearStatus,
						platinumScoreMax: score.platinumScore ?? null,
						platinumScoreStar: score.platinumStars ?? null
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
					clearStatus,
					score.score,
					score.maxCombo ?? null,
					score.judgements?.miss ?? null,
					score.judgements?.hit ?? null,
					score.judgements?.break ?? null,
					score.judgements?.cbreak ?? null,
					score.bellCount ?? null,
					score.totalBellCount ?? null,
					score.damage ?? null,
					isFullCombo,
					isFullBell,
					isAllBreak,
					playerRating,
					score.platinumScore ?? null,
					score.platinumScoreMax ?? null,
					score.platinumStars ?? null,
					playDate,
					playDate,
					version
				])
			}

			const rowsToUpsertBest: BestUpsertRow[] = [...bestByChart.values()]
				.filter(best => isOngekiBestUpdate(existingBestMap.get(`${best.musicId}:${best.level}`), best))
				.map(best => [
					userId,
					best.musicId,
					best.level,
					best.playCount,
					best.techScoreMax,
					best.techScoreRank,
					best.maxComboCount,
					best.isFullBell,
					best.isFullCombo,
					best.isAllBreake,
					best.clearStatus,
					best.platinumScoreMax,
					best.platinumScoreStar
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
					.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
					.join(", ")

				const [result] = await conn.execute<ResultSetHeader>(
					`INSERT INTO ongeki_score_playlog (
						user,
						musicId,
						level,
					clearStatus,
					techScore,
					maxCombo,
					judgeMiss,
					judgeHit,
					judgeBreak,
					judgeCriticalBreak,
					bellCount,
					totalBellCount,
					damageCount,
					isFullCombo,
					isFullBell,
					isAllBreak,
					playerRating,
					platinumScore,
					platinumScoreMax,
					platinumScoreStar,
					userPlayDate,
						playDate,
						version
					) VALUES ${valuePlaceholders}`,
					chunk.flat()
				)

				importedCount += result.affectedRows
			}

			let bestUpdatedCount = 0

			for (const chunk of chunkRows(rowsToUpsertBest)) {
				const bestValuePlaceholders = chunk
					.map(() => "(?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, ?, ?, ?, 0, ?, 0, ?, ?)")
					.join(", ")

				await conn.execute<ResultSetHeader>(
					`INSERT INTO ongeki_score_best (
						user,
						musicId,
						level,
						playCount,
						techScoreMax,
						techScoreRank,
						battleScoreMax,
						battleScoreRank,
						maxComboCount,
						maxOverKill,
						maxTeamOverKill,
						isFullBell,
						isFullCombo,
						isAllBreake,
						isLock,
						clearStatus,
						isStoryWatched,
						platinumScoreMax,
						platinumScoreStar
					) VALUES ${bestValuePlaceholders}
					ON DUPLICATE KEY UPDATE
						playCount = GREATEST(ongeki_score_best.playCount, VALUES(playCount)),
						techScoreRank = IF(VALUES(techScoreMax) > ongeki_score_best.techScoreMax, VALUES(techScoreRank), ongeki_score_best.techScoreRank),
						techScoreMax = GREATEST(ongeki_score_best.techScoreMax, VALUES(techScoreMax)),
						maxComboCount = GREATEST(ongeki_score_best.maxComboCount, VALUES(maxComboCount)),
						isFullBell = GREATEST(ongeki_score_best.isFullBell, VALUES(isFullBell)),
						isFullCombo = GREATEST(ongeki_score_best.isFullCombo, VALUES(isFullCombo)),
						isAllBreake = GREATEST(ongeki_score_best.isAllBreake, VALUES(isAllBreake)),
						clearStatus = GREATEST(ongeki_score_best.clearStatus, VALUES(clearStatus)),
						platinumScoreMax = CASE
							WHEN ongeki_score_best.platinumScoreMax IS NULL THEN VALUES(platinumScoreMax)
							WHEN VALUES(platinumScoreMax) IS NULL THEN ongeki_score_best.platinumScoreMax
							ELSE GREATEST(ongeki_score_best.platinumScoreMax, VALUES(platinumScoreMax))
						END,
						platinumScoreStar = CASE
							WHEN VALUES(platinumScoreStar) > COALESCE(ongeki_score_best.platinumScoreStar, 0) THEN VALUES(platinumScoreStar)
							ELSE ongeki_score_best.platinumScoreStar
						END`,
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

export { OngekiKamaitachiRoutes as OngekiScoreExporterRoutes }
