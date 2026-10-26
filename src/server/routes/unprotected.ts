import argon2 from "argon2"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"

import { DB } from "@/app/shared/types/db"
import { loginSchema, signupSchema } from "@/app/shared/types/validation/auth"

import { db } from "../db"
import { validateJson } from "../middleware/validator"
import { clearCookie, signAndSetCookie } from "../utils/cookie"
import { rethrowWithMessage } from "../utils/error"
import { verifyTurnstileToken } from "../utils/turnstile"
import { getUserGameVersions } from "../utils/versions"

/**
 * Unprotected routes which should not require authentication.
 * Note: Rate limiting is now applied globally at the server level for all /api/* routes
 */

const UnprotectedRoutes = new Hono()
	.get("/health", c => {
		return c.json({ status: "ok" })
	})
	.post("/login", validateJson(loginSchema), async c => {
		const { username, password, turnstileToken } = c.req.valid("json")

		await verifyTurnstileToken(turnstileToken, c.req.raw.headers)

		const conn = await db.getConnection()
		try {
			await conn.beginTransaction()

			// Find user by username
			const [users] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>(
				"SELECT * FROM aime_user WHERE username = ?",
				[username]
			)
			const foundUser = users[0]
			if (!foundUser || !foundUser.password) {
				throw new HTTPException(401, {
					message: "Invalid username or password"
				})
			}

			// Verify password
			const passwordMatch = await argon2.verify(foundUser.password, password)
			if (!passwordMatch) {
				throw new HTTPException(401, {
					message: "Invalid username or password"
				})
			}
			const [aimeCards] = await conn.execute<(DB.AimeCard & RowDataPacket)[]>(
				"SELECT access_code FROM aime_card WHERE user = ?",
				[foundUser.id]
			)
			const aimeCard = aimeCards[0]

			// Update last login date
			await conn.execute(
				`
                        UPDATE aime_user
                        SET last_login_date = NOW()
                        WHERE id = ?
                    `,
				[foundUser.id]
			)

			// Grab latest versions
			const versions = await getUserGameVersions(foundUser.id, conn)

			// Successful login
			const user = await signAndSetCookie(c, foundUser, aimeCard, versions)

			await conn.commit()
			return c.json(user)
		} catch (error) {
			await conn.rollback()
			throw rethrowWithMessage("Failed to login", error)
		} finally {
			conn.release()
		}
	})
	.post("/logout", async c => {
		// Clear the auth_token cookie
		clearCookie(c)
		return c.json({ message: "Logged out" })
	})
	.post("/signup", validateJson(signupSchema), async c => {
		const body = c.req.valid("json")
		const { username, password, accessCode, turnstileToken } = body

		await verifyTurnstileToken(turnstileToken, c.req.raw.headers)

		// NOTE:
		//   Lots of separate queries here, could combine them with joins
		const conn = await db.getConnection()
		try {
			await conn.beginTransaction()

			// Verify access code and get user ID
			const [aimeCards] = await conn.execute<(DB.AimeCard & RowDataPacket)[]>(
				"SELECT * FROM aime_card WHERE access_code = ?",
				[accessCode]
			)
			const aimeCard = aimeCards[0]
			if (!aimeCard) {
				throw new HTTPException(404, { message: "Aime Card not found" })
			}

			// Check if user already has an account (username or password is set)
			const userId = aimeCard.user
			const [users] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>("SELECT * FROM aime_user WHERE id = ?", [
				userId
			])
			const existingUser = users[0]

			// check contents of json payload against existing users
			if (existingUser?.username || existingUser?.password) {
				throw new HTTPException(409, {
					message: "Account already exists for this user"
				})
			}

			// Check if username is already taken
			const [usernameCheckUsers] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>(
				"SELECT * FROM aime_user WHERE username = ?",
				[username]
			)
			if (usernameCheckUsers[0]) {
				throw new HTTPException(409, {
					message: "Username already exists"
				})
			}

			// Hash password
			const hashedPassword = await argon2.hash(password)

			// Update existing user with the verified user ID
			const [result] = await conn.execute<ResultSetHeader>(
				"UPDATE aime_user SET username = ?, password = ? WHERE id = ?",
				[username, hashedPassword, userId]
			)
			// Check if the update was successful
			if (result.affectedRows === 0) {
				throw new HTTPException(500, {
					message: "Failed to update aime_user"
				})
			}

			// NOTE: aimedb makes default users have a placeholder NULL name so we need to get the new username after we insert it
			const [updatedUsers] = await conn.execute<(DB.AimeUser & RowDataPacket)[]>(
				"SELECT * FROM aime_user WHERE id = ?",
				[userId]
			)
			const updatedUser = updatedUsers[0]

			// Update last login date
			await conn.execute(
				`
                        UPDATE aime_user
     					SET last_login_date = NOW()
     					WHERE id = ?
                    `,
				[userId]
			)

			// Grab user game versions
			const versions = await getUserGameVersions(userId, conn)
			const user = await signAndSetCookie(c, updatedUser, aimeCard, versions)

			await conn.commit()
			return c.json(user)
		} catch (error) {
			await conn.rollback()
			throw rethrowWithMessage("Failed to create account", error)
		} finally {
			conn.release()
		}
	})

export { UnprotectedRoutes }
