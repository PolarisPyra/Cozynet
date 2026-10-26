import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { z } from "zod"

import { UserRole } from "@/app/shared/types"
import { type ExecutableConnection, type ExecutablePool, db } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

type UserRow = { id: number; username: string | null } & RowDataPacket
type GameUsernameRow = { user: number; userName: string | null } & RowDataPacket
type PruneArcadeRow = { id: number; name: string | null; serial: string | null } & RowDataPacket
const assertAdmin = (userId: number | undefined, permissions: number | undefined) => {
	if (!userId || permissions !== UserRole.Admin) {
		throw new HTTPException(403)
	}
}

const getTargetUser = async (targetId: number) => {
	const [users] = await db.execute<UserRow[]>("SELECT id, username FROM aime_user WHERE id = ?", [targetId])
	const targetUser = users[0]
	if (!targetUser) {
		throw new HTTPException(404, { message: "User not found" })
	}
	return targetUser
}

const getUserColumnTables = async (executor: ExecutablePool | ExecutableConnection | PoolConnection = db) => {
	const [tables] = await executor.execute<RowDataPacket[]>(
		`SELECT TABLE_NAME
		 FROM information_schema.columns
		 WHERE TABLE_SCHEMA = DATABASE()
		 AND COLUMN_NAME = 'user'
		 AND TABLE_NAME <> 'aime_user'`
	)
	return tables.map(table => String(table.TABLE_NAME))
}

const getPrunableUsers = async (currentUserId: number) => {
	const [users] = await db.execute<RowDataPacket[]>(
		`SELECT id, username, email
		FROM aime_user
		WHERE id <> ?
		AND permissions <> ?
		AND NOT EXISTS (
			SELECT 1 FROM chuni_profile_data WHERE user = aime_user.id AND userName IS NOT NULL AND TRIM(userName) <> ''
		)
		AND NOT EXISTS (
			SELECT 1 FROM ongeki_profile_data WHERE user = aime_user.id AND userName IS NOT NULL AND TRIM(userName) <> ''
		)
		AND NOT EXISTS (
			SELECT 1 FROM mai2_profile_detail WHERE user = aime_user.id AND userName IS NOT NULL AND TRIM(userName) <> ''
		)
		ORDER BY id ASC`,
		[currentUserId, UserRole.Admin]
	)
	const tables = await getUserColumnTables()
	const plans = []

	for (const user of users) {
		const linkedData = []
		for (const table of tables) {
			const [rows] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE user = ?`, [
				user.id
			])
			const count = Number(rows[0]?.count ?? 0)
			if (count > 0) linkedData.push({ table, count })
		}
		const [arcades] = await db.execute<PruneArcadeRow[]>(
			`SELECT DISTINCT a.id, a.name, m.serial
			FROM arcade_owner ao
			INNER JOIN arcade a ON a.id = ao.arcade
			LEFT JOIN machine m ON m.arcade = a.id
			WHERE ao.user = ?
			ORDER BY a.id ASC`,
			[user.id]
		)
		plans.push({
			id: user.id,
			username: user.username,
			email: user.email,
			linkedData,
			keychips: arcades
				.filter(arcade => arcade.serial)
				.map(arcade => ({ serial: arcade.serial, arcadeName: arcade.name }))
		})
	}

	return plans
}

const generateSegaKeychipSerial = async () => {
	for (let attempt = 0; attempt < 20; attempt++) {
		let uniqueNumbers = ""
		while (uniqueNumbers.length < 4) {
			const digit = Math.floor(Math.random() * 10).toString()
			if (!uniqueNumbers.includes(digit)) uniqueNumbers += digit
		}
		const randomNumbers = Math.floor(1000 + Math.random() * 9000)
			.toString()
			.padStart(4, "0")
		const keychipId = `A69E01A${uniqueNumbers}${randomNumbers}`

		const [existingMachine] = await db.execute<RowDataPacket[]>("SELECT id FROM machine WHERE serial = ? LIMIT 1", [
			keychipId
		])
		if (existingMachine.length === 0) return keychipId
	}

	throw new HTTPException(409, { message: "Failed to generate a unique keychip serial" })
}

const pcbidSchema = z
	.string()
	.trim()
	.regex(/^0120[01][0-9A-Fa-f]{15}$/, "PCBID must match 0120[0|1][15 hex digits]")

const AdminUserRoutes = new Hono()
	.get("/", async c => {
		try {
			const { userId, permissions } = c.payload

			assertAdmin(userId, permissions)

			// Get all users
			const [users] = await db.execute<RowDataPacket[]>(
				"SELECT id, username, email, permissions, created_date, last_login_date, suspend_expire_time FROM aime_user ORDER BY id ASC"
			)
			const [chunithmNames] = await db.execute<GameUsernameRow[]>(
				`SELECT profile.user, profile.userName
				FROM chuni_profile_data profile
				INNER JOIN (
					SELECT user, MAX(version) AS version
					FROM chuni_profile_data
					WHERE userName IS NOT NULL AND TRIM(userName) <> ''
					GROUP BY user
				) latest ON latest.user = profile.user AND latest.version = profile.version
				WHERE profile.userName IS NOT NULL AND TRIM(profile.userName) <> ''`
			)
			const [ongekiNames] = await db.execute<GameUsernameRow[]>(
				`SELECT profile.user, profile.userName
				FROM ongeki_profile_data profile
				INNER JOIN (
					SELECT user, MAX(version) AS version
					FROM ongeki_profile_data
					WHERE userName IS NOT NULL AND TRIM(userName) <> ''
					GROUP BY user
				) latest ON latest.user = profile.user AND latest.version = profile.version
				WHERE profile.userName IS NOT NULL AND TRIM(profile.userName) <> ''`
			)
			const [maimaiNames] = await db.execute<GameUsernameRow[]>(
				`SELECT profile.user, profile.userName
				FROM mai2_profile_detail profile
				INNER JOIN (
					SELECT user, MAX(version) AS version
					FROM mai2_profile_detail
					WHERE userName IS NOT NULL AND TRIM(userName) <> ''
					GROUP BY user
				) latest ON latest.user = profile.user AND latest.version = profile.version
				WHERE profile.userName IS NOT NULL AND TRIM(profile.userName) <> ''`
			)
			const gameUsernames = new Map<
				number,
				{ chunithm: string | null; ongeki: string | null; maimaidx: string | null }
			>()
			for (const row of chunithmNames)
				gameUsernames.set(row.user, { chunithm: row.userName, ongeki: null, maimaidx: null })
			for (const row of ongekiNames) {
				const names = gameUsernames.get(row.user) ?? { chunithm: null, ongeki: null, maimaidx: null }
				names.ongeki = row.userName
				gameUsernames.set(row.user, names)
			}
			for (const row of maimaiNames) {
				const names = gameUsernames.get(row.user) ?? { chunithm: null, ongeki: null, maimaidx: null }
				names.maimaidx = row.userName
				gameUsernames.set(row.user, names)
			}

			// Get cards for all users
			const [cards] = await db.execute<RowDataPacket[]>(
				"SELECT id, user, access_code, created_date, is_locked, is_banned FROM aime_card"
			)

			// Get arcades for all users
			const [arcades] = await db.execute<RowDataPacket[]>(
				`SELECT ao.user, a.id, a.name, a.nickname, m.id AS machineId, m.serial, m.pcbid
				 FROM arcade_owner ao
				 JOIN arcade a ON ao.arcade = a.id
				 LEFT JOIN machine m ON m.arcade = a.id
				 ORDER BY a.id ASC, m.id ASC`
			)
			// Combine data
			const usersWithDetails = users.map(user => {
				const userArcades = arcades.filter(arcade => arcade.user === user.id)

				return {
					...user,
					cards: cards.filter(card => card.user === user.id),
					arcades: userArcades,
					gameUsernames: gameUsernames.get(user.id) ?? { chunithm: null, ongeki: null, maimaidx: null }
				}
			})

			return c.json({ users: usersWithDetails })
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch users", error)
		}
	})
	.get("/prune-inactive/preview", async c => {
		try {
			const { userId, permissions } = c.payload
			assertAdmin(userId, permissions)
			const users = await getPrunableUsers(userId as number)
			return c.json({ users, total: users.length })
		} catch (error) {
			throw rethrowWithMessage("Failed to preview inactive user pruning", error)
		}
	})
	.post(
		"/prune-inactive",
		validateJson(z.object({ userIds: z.array(z.number().int().positive()).min(1) })),
		async c => {
			try {
				const { userId: currentUserId, permissions } = c.payload
				assertAdmin(currentUserId, permissions)
				const { userIds } = c.req.valid("json")
				const uniqueUserIds = [...new Set(userIds)]
				const plans = await getPrunableUsers(currentUserId as number)
				const eligibleIds = new Set(plans.map(user => user.id))
				if (uniqueUserIds.some(id => !eligibleIds.has(id))) {
					throw new HTTPException(409, {
						message: "The inactive-user list changed. Refresh the preview and try again."
					})
				}

				const connection = await db.getConnection()
				try {
					await connection.beginTransaction()
					const tables = await getUserColumnTables(connection)
					const deletedKeychips: { serial: string; arcadeName: string | null }[] = []

					for (const targetId of uniqueUserIds) {
						const [ownedArcades] = await connection.execute<PruneArcadeRow[]>(
							`SELECT DISTINCT a.id, a.name, m.serial
							FROM arcade_owner ao
							INNER JOIN arcade a ON a.id = ao.arcade
							LEFT JOIN machine m ON m.arcade = a.id
							WHERE ao.user = ?`,
							[targetId]
						)
						for (const arcade of ownedArcades) {
							if (arcade.serial) deletedKeychips.push({ serial: arcade.serial, arcadeName: arcade.name })
						}

						for (const table of tables) {
							await connection.execute(`DELETE FROM \`${table}\` WHERE user = ?`, [targetId])
						}

						for (const arcade of ownedArcades) {
							const [remainingOwners] = await connection.execute<RowDataPacket[]>(
								"SELECT COUNT(*) AS count FROM arcade_owner WHERE arcade = ?",
								[arcade.id]
							)
							if (Number(remainingOwners[0]?.count ?? 0) === 0) {
								await connection.execute("DELETE FROM machine WHERE arcade = ?", [arcade.id])
								await connection.execute("DELETE FROM arcade WHERE id = ?", [arcade.id])
							}
						}
						await connection.execute("DELETE FROM aime_user WHERE id = ?", [targetId])
					}

					await connection.commit()
					return c.json({ success: true, deletedUserIds: uniqueUserIds, deletedKeychips })
				} catch (error) {
					await connection.rollback()
					throw error
				} finally {
					connection.release()
				}
			} catch (error) {
				throw rethrowWithMessage("Failed to prune inactive users", error)
			}
		}
	)
	.post("/:id/keychip/generate", async c => {
		try {
			const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
			const targetId = parseInt(c.req.param("id"))

			assertAdmin(currentUserId, currentUserPermissions)

			const targetUser = await getTargetUser(targetId)
			const keychipId = await generateSegaKeychipSerial()
			const displayName = targetUser.username || `User ${targetId}`
			const arcadeName = `${displayName}'s SEGA arcade`
			const arcadeNickname = `${displayName}'s SEGA arcade`

			const connection = await db.getConnection()
			try {
				await connection.beginTransaction()

				const [arcadeResult] = await connection.execute<ResultSetHeader>(
					"INSERT INTO arcade (name, nickname) VALUES (?, ?)",
					[arcadeName, arcadeNickname]
				)
				const arcadeId = arcadeResult.insertId

				await connection.execute<ResultSetHeader>(
					"INSERT INTO arcade_owner (user, arcade, permissions) VALUES (?, ?, ?)",
					[targetId, arcadeId, 1]
				)

				await connection.execute<ResultSetHeader>("INSERT INTO machine (arcade, serial, game) VALUES (?, ?, ?)", [
					arcadeId,
					keychipId,
					null
				])

				await connection.commit()

				return c.json({
					success: true,
					keychipId,
					arcadeId,
					arcadeName,
					arcadeNickname,
					userId: targetId,
					username: targetUser.username
				})
			} catch (error) {
				await connection.rollback()
				throw error
			} finally {
				connection.release()
			}
		} catch (error) {
			throw rethrowWithMessage("Failed to generate keychip for user", error)
		}
	})
	.post(
		"/pcbid/generate",
		validateJson(
			z.object({
				userId: z.number().int().positive(),
				pcbid: pcbidSchema
			})
		),
		async c => {
			try {
				const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
				assertAdmin(currentUserId, currentUserPermissions)
				const { userId: targetId, pcbid } = c.req.valid("json")

				const connection = await db.getConnection()
				try {
					await connection.beginTransaction()
					const [userMachines] = await connection.execute<RowDataPacket[]>(
						`SELECT m.id
						FROM machine m
						INNER JOIN arcade_owner ao ON ao.arcade = m.arcade
						WHERE ao.user = ?
						ORDER BY m.id ASC
						LIMIT 1
						FOR UPDATE`,
						[targetId]
					)
					const machineId = userMachines[0]?.id
					if (!machineId) {
						throw new HTTPException(404, { message: "Selected user has no machine to update" })
					}

					const [existingMachines] = await connection.execute<RowDataPacket[]>(
						"SELECT id FROM machine WHERE pcbid = ? AND id <> ? LIMIT 1 FOR UPDATE",
						[pcbid, machineId]
					)
					if (existingMachines.length > 0) {
						throw new HTTPException(409, { message: "That PCBID is already in use" })
					}

					await connection.execute<ResultSetHeader>("UPDATE machine SET pcbid = ? WHERE id = ?", [pcbid, machineId])

					await connection.commit()
					return c.json({ success: true, machineId, pcbid, userId: targetId })
				} catch (error) {
					await connection.rollback()
					throw error
				} finally {
					connection.release()
				}
			} catch (error) {
				throw rethrowWithMessage("Failed to generate PCBID", error)
			}
		}
	)
	.put(
		"/:id",
		validateJson(
			z.object({
				username: z.string().min(1),
				email: z.string().email().optional(),
				permissions: z.number().int()
			})
		),
		async c => {
			try {
				const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
				const targetId = parseInt(c.req.param("id"))

				if (!currentUserId || currentUserPermissions !== UserRole.Admin) {
					throw new HTTPException(403)
				}

				const body = c.req.valid("json")
				const { username, email, permissions } = body

				if (email) {
					await db.execute<ResultSetHeader>(
						"UPDATE aime_user SET username = ?, email = ?, permissions = ? WHERE id = ?",
						[username, email, permissions, targetId]
					)
				} else {
					await db.execute<ResultSetHeader>("UPDATE aime_user SET username = ?, permissions = ? WHERE id = ?", [
						username,
						permissions,
						targetId
					])
				}

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to update user", error)
			}
		}
	)
	.delete("/:id", async c => {
		try {
			const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
			const targetId = parseInt(c.req.param("id"))

			if (!currentUserId || currentUserPermissions !== UserRole.Admin) {
				throw new HTTPException(403)
			}

			// Cannot delete oneself
			if (currentUserId === targetId) {
				throw new HTTPException(400, { message: "Cannot delete your own account" })
			}

			// Get all tables dynamically
			const [tables] = await db.execute<RowDataPacket[]>(
				`SELECT TABLE_NAME 
				 FROM information_schema.columns 
				 WHERE TABLE_SCHEMA = DATABASE() 
				 AND COLUMN_NAME = 'user'`
			)

			// Execute deletes
			const connection = await db.getConnection()
			try {
				await connection.beginTransaction()

				// Delete from all linked tables
				for (const table of tables) {
					const tableName = table.TABLE_NAME
					await connection.execute(`DELETE FROM \`${tableName}\` WHERE user = ?`, [targetId])
				}

				// Finally delete the user
				await connection.execute("DELETE FROM aime_user WHERE id = ?", [targetId])

				await connection.commit()
			} catch (error) {
				await connection.rollback()
				throw error
			} finally {
				connection.release()
			}

			return c.json({ success: true })
		} catch (error) {
			throw rethrowWithMessage("Failed to delete user", error)
		}
	})
	.get("/:id/profiles", async c => {
		try {
			const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
			const targetId = parseInt(c.req.param("id"))

			if (!currentUserId || currentUserPermissions !== UserRole.Admin) {
				throw new HTTPException(403)
			}

			const [chunithmProfiles] = await db.execute<RowDataPacket[]>("SELECT * FROM chuni_profile_data WHERE user = ?", [
				targetId
			])

			const [ongekiProfiles] = await db.execute<RowDataPacket[]>("SELECT * FROM ongeki_profile_data WHERE user = ?", [
				targetId
			])

			const [maimaiProfiles] = await db.execute<RowDataPacket[]>("SELECT * FROM mai2_profile_detail WHERE user = ?", [
				targetId
			])

			return c.json({
				chunithm: chunithmProfiles,
				ongeki: ongekiProfiles,
				maimaidx: maimaiProfiles
			})
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch user profiles", error)
		}
	})
	.put(
		"/:id/profiles/:game/:version",
		validateJson(
			z.record(z.string().regex(/^[A-Za-z0-9_]+$/), z.union([z.string(), z.number(), z.boolean(), z.null()]))
		),
		async c => {
			try {
				const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
				const targetId = parseInt(c.req.param("id"))
				const game = c.req.param("game")
				const version = parseInt(c.req.param("version"))

				if (!currentUserId || currentUserPermissions !== UserRole.Admin) {
					throw new HTTPException(403)
				}

				const body = c.req.valid("json")

				let tableName = ""
				if (game === "chunithm" || game === "chunithmnew") tableName = "chuni_profile_data"
				else if (game === "ongeki") tableName = "ongeki_profile_data"
				else if (game === "maimai" || game === "maimaidx") tableName = "mai2_profile_detail"
				else throw new HTTPException(400, { message: "Invalid game" })

				// Build dynamic update query
				// Filter out restricted keys
				const restrictedKeys = ["id", "user", "version"]
				const entries = Object.entries(body).filter(([key]) => !restrictedKeys.includes(key))

				if (entries.length === 0) return c.json({ success: true })

				const setFields = entries.map(([key]) => `\`${key}\` = ?`).join(", ")
				const values = entries.map(([, val]) => val)

				await db.execute<ResultSetHeader>(`UPDATE \`${tableName}\` SET ${setFields} WHERE user = ? AND version = ?`, [
					...values,
					targetId,
					version
				])

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to update user profile", error)
			}
		}
	)
	.post("/:id/ban", validateJson(z.object({ banned: z.boolean() })), async c => {
		try {
			const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
			const targetId = parseInt(c.req.param("id"))
			const { banned } = c.req.valid("json")

			if (!currentUserId || currentUserPermissions !== UserRole.Admin) {
				throw new HTTPException(403)
			}

			await db.execute("UPDATE aime_card SET is_banned = ? WHERE user = ?", [banned ? 1 : 0, targetId])
			return c.json({ success: true })
		} catch (error) {
			throw rethrowWithMessage("Failed to update ban status", error)
		}
	})
	.post("/:id/lock", validateJson(z.object({ locked: z.boolean() })), async c => {
		try {
			const { userId: currentUserId, permissions: currentUserPermissions } = c.payload
			const targetId = parseInt(c.req.param("id"))
			const { locked } = c.req.valid("json")

			if (!currentUserId || currentUserPermissions !== UserRole.Admin) {
				throw new HTTPException(403)
			}

			await db.execute("UPDATE aime_card SET is_locked = ? WHERE user = ?", [locked ? 1 : 0, targetId])
			return c.json({ success: true })
		} catch (error) {
			throw rethrowWithMessage("Failed to update lock status", error)
		}
	})

export { AdminUserRoutes }
