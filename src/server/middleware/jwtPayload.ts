import { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import type { RowDataPacket } from "mysql2"

import { db } from "../db"
import { UserMeta } from "../types/jwt"

declare module "hono" {
	interface Context {
		payload: UserMeta
	}
}

/**
 *  Just reassigns the JWT payload directly to the context,
 *  instead of having to access it through a string key everywhere.
 *  Permissions are re-read from the database so role changes and deleted users take effect immediately.
 */
export const jwtPayloadMiddleware = (): MiddlewareHandler => {
	return async (c, next) => {
		let payload = {} as UserMeta
		try {
			const jwtPayload = c.get("jwtPayload") as { user?: string } | undefined
			if (jwtPayload && jwtPayload.user) {
				payload = JSON.parse(jwtPayload.user) as UserMeta
			}
		} catch {
			// If parsing fails, keep the empty payload (will cause 401/403 in routes that require auth)
		}

		if (payload.userId) {
			const [users] = await db.execute<({ permissions: number | null } & RowDataPacket)[]>(
				"SELECT permissions FROM aime_user WHERE id = ?",
				[payload.userId]
			)
			if (!users[0]) {
				throw new HTTPException(401, { message: "User no longer exists" })
			}
			payload.permissions = users[0].permissions || 0
		}

		c.payload = payload
		await next()
	}
}
