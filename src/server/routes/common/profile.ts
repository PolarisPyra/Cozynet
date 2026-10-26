import argon2 from "argon2"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { DB } from "@/app/shared/types"
import { passwordSchema, usernameSchema } from "@/app/shared/types/validation/auth"
import { db, type ExecutableConnection } from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { signAndSetCookie } from "@/server/utils/cookie"
import { rethrowWithMessage } from "@/server/utils/error"
import { getUserGameVersions } from "@/server/utils/versions"

const ProfileRoutes = new Hono()
	.get("/versions", async c => {
		try {
			const { userId } = c.payload
			if (!userId) throw new HTTPException(403)

			// Get all Chunithm profile versions
			const [chunithmProfiles] = await db.execute<(DB.ChuniProfileData & RowDataPacket)[]>(
				`
					SELECT 
						version,
						userName,
						level,
						reincarnationNum,
						playerRating,
						playCount,
						lastPlayDate
					FROM chuni_profile_data
					WHERE user = ?
					ORDER BY version DESC
				`,
				[userId]
			)

			// Get all Ongeki profile versions
			const [ongekiProfiles] = await db.execute<(DB.OngekiProfileData & RowDataPacket)[]>(
				`
					SELECT 
						version,
						userName,
						level,
						reincarnationNum,
						playerRating,
						newPlayerRating,
						playCount,
						lastPlayDate
					FROM ongeki_profile_data
					WHERE user = ?
					ORDER BY version DESC
				`,
				[userId]
			)

			// Get all Maimai DX profile versions
			const [maimaiProfiles] = await db.execute<(DB.Mai2ProfileDetail & RowDataPacket)[]>(
				`
					SELECT 
						version,
						userName,
						playerRating,
						playCount,
						lastPlayDate
					FROM mai2_profile_detail
					WHERE user = ?
					ORDER BY version DESC
				`,
				[userId]
			)

			return c.json({
				chunithm: chunithmProfiles,
				ongeki: ongekiProfiles,
				maimaidx: maimaiProfiles
			})
		} catch (error) {
			if (error instanceof HTTPException) throw error
			throw rethrowWithMessage("Failed to fetch profile versions", error)
		}
	})
	.post(
		"/username",
		validateJson(
			z.object({
				username: usernameSchema
			})
			),
			async c => {
				const conn = (await db.getConnection()) as ExecutableConnection
			try {
				await conn.beginTransaction()

				const { userId, aimeCardId } = c.payload
				const { username } = c.req.valid("json")

				if (!userId || !aimeCardId) throw new HTTPException(403)

				// Check if username is already taken by another user
				const [existingUsers] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>(
					"SELECT * FROM aime_user WHERE username = ? AND id != ?",
					[username, userId]
				)

				if (existingUsers.length > 0) {
					throw new HTTPException(409, { message: "Username already exists" })
				}

				// Update username
				const [result] = await conn.execute<ResultSetHeader>("UPDATE aime_user SET username = ? WHERE id = ?", [
					username,
					userId
				])

				if (result.affectedRows === 0) {
					throw new HTTPException(404, { message: "User not found" })
				}

				// Refresh the JWT token with updated user data
				const [users] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>("SELECT * FROM aime_user WHERE id = ?", [
					userId
				])
				const user = users[0]

				const [cards] = await conn.execute<(DB.AimeCard & RowDataPacket)[]>(
					"SELECT * FROM aime_card WHERE access_code = ?",
					[aimeCardId]
				)
				const card = cards[0]

				if (!user || !card) {
					throw new HTTPException(404)
				}

				const versions = await getUserGameVersions(userId, conn)
				const cookieResult = await signAndSetCookie(c, user, card, versions)

				await conn.commit()
				return c.json(cookieResult)
			} catch (error) {
				await conn.rollback()
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to update username", error)
			} finally {
				conn.release()
			}
		}
	)
	.post(
		"/password",
		validateJson(
			z.object({
				currentPassword: z.string().min(1, "Current password is required"),
				newPassword: passwordSchema
			})
			),
			async c => {
				const conn = (await db.getConnection()) as ExecutableConnection
			try {
				await conn.beginTransaction()

				const { userId, aimeCardId } = c.payload
				const { currentPassword, newPassword } = c.req.valid("json")

				if (!userId || !aimeCardId) throw new HTTPException(403)

				// Get user and verify current password
				const [users] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>("SELECT * FROM aime_user WHERE id = ?", [
					userId
				])
				const user = users[0]

				if (!user) {
					throw new HTTPException(404, { message: "User not found" })
				}

				// Verify current password
				const passwordMatch = await argon2.verify(user.password, currentPassword)
				if (!passwordMatch) {
					throw new HTTPException(401, { message: "Current password is incorrect" })
				}

				// Hash new password
				const hashedPassword = await argon2.hash(newPassword)

				// Update password
				const [result] = await conn.execute<ResultSetHeader>("UPDATE aime_user SET password = ? WHERE id = ?", [
					hashedPassword,
					userId
				])

				if (result.affectedRows === 0) {
					throw new HTTPException(404, { message: "User not found" })
				}

				// Get updated user and card
				const [updatedUsers] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>(
					"SELECT * FROM aime_user WHERE id = ?",
					[userId]
				)
				const updatedUser = updatedUsers[0]

				const [cards] = await conn.execute<(DB.AimeCard & RowDataPacket)[]>(
					"SELECT * FROM aime_card WHERE access_code = ?",
					[aimeCardId]
				)
				const card = cards[0]

				if (!updatedUser || !card) {
					throw new HTTPException(404)
				}

				const versions = await getUserGameVersions(userId, conn)
				const cookieResult = await signAndSetCookie(c, updatedUser, card, versions)

				await conn.commit()
				return c.json(cookieResult)
			} catch (error) {
				await conn.rollback()
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to update password", error)
			} finally {
				conn.release()
			}
		}
	)

export { ProfileRoutes }
