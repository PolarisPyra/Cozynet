import { JWTPayload as HonoJWTPayload } from "hono/utils/jwt/types"

import { DaphnisUserOptionVersionKey } from "@/app/shared/types"

type TrimmedJWT = Pick<HonoJWTPayload, "exp" | "nbf" | "iat">
type Stringified<_> = string

export type GameVersions = Record<DaphnisUserOptionVersionKey, number>

/**
 * JWT Payload interface extending Hono's base JWT type
 */
export type UserMeta = {
	userId: number
	username: string
	permissions: number
	versions: GameVersions
	aimeCardId?: string
}

export interface JWTPayload extends TrimmedJWT {
	[key: string]: unknown

	// We're explictly setting exp so should be defined, unlike Hono's type
	exp: number

	user: Stringified<UserMeta>

	// Fingerprint of the password hash the session was issued under
	pwf: string
}
