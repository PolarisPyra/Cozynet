import { Context } from "hono"
import { setCookie } from "hono/cookie"
import { sign } from "hono/jwt"
import { createHash } from "node:crypto"

import { DB } from "@/app/shared/types"

import { JWTPayload } from "../types"
import { GameVersions, UserMeta } from "../types/jwt"

/** Ties a session to the password it was issued under, so changing the password ends every older session. */
export const passwordFingerprint = (passwordHash: string | null | undefined) =>
	createHash("sha256")
		.update(passwordHash ?? "")
		.digest("hex")
		.slice(0, 16)

export const signAndSetCookie = async (
	c: Context,
	user: DB.AimeUser,
	card: DB.AimeCard,
	versions: GameVersions
): Promise<UserMeta> => {
	const userMeta = {
		userId: user.id,
		username: user.username,
		permissions: user.permissions || 0,
		aimeCardId: card?.access_code ?? undefined,
		versions
	}
	// Create JWT token
	const payload: JWTPayload = {
		user: JSON.stringify(userMeta),
		pwf: passwordFingerprint(user.password),
		exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 // 7 days expiration
	}

	const { JWT_SECRET, NODE_ENV, DOMAIN } = process.env

	const token = await sign(payload, JWT_SECRET!)

	// Set JWT token as a cookie
	setCookie(c, "auth_token", token, {
		httpOnly: true,
		secure: NODE_ENV === "production",
		sameSite: "Strict",
		maxAge: 60 * 60 * 24 * 7, // 7 days
		path: "/",
		domain: NODE_ENV === "production" ? DOMAIN : "localhost"
	})

	return userMeta
}

export const clearCookie = (c: Context) => {
	const { NODE_ENV, DOMAIN } = process.env

	setCookie(c, "auth_token", "", {
		httpOnly: true,
		secure: NODE_ENV === "production",
		sameSite: "Strict",
		maxAge: 0,
		path: "/",
		domain: NODE_ENV === "production" ? DOMAIN : "localhost"
	})
}
