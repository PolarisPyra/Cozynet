import { z } from "zod"

/**
 * Shared authentication validation schemas
 */

export const passwordSchema = z
	.string()
	.min(8, "Password must be at least 8 characters")
	.max(128, "Password must be less than 128 characters")

export const usernameSchema = z
	.string()
	.trim()
	.min(3, "Username must be at least 3 characters")
	.max(50, "Username must be less than 50 characters")
	.regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, underscores, and hyphens")

export const accessCodeSchema = z.string().trim().length(20, "Access code must be exactly 20 characters")
export const eamuseAccessCodeSchema = z
	.string()
	.trim()
	.regex(/^E004[0-9A-Fa-f]{12}$/, "e-amusement code must be a 16-character E004 code")
export const turnstileTokenSchema = z.string().trim().min(1).max(2048)

export const keychipSerialSchema = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[A-Z0-9]{15}$/, "Keychip serial must be 15 uppercase alphanumeric characters")

export const arcadeNameSchema = z.string().trim().min(1).max(255)
export const arcadeNicknameSchema = z.string().trim().min(1).max(255)

export const loginSchema = z.object({
	username: z.string().trim().min(1, "Username is required").max(50, "Username is too long"),
	password: z.string().min(1, "Password is required").max(128, "Password is too long"),
	turnstileToken: turnstileTokenSchema.optional()
})

export const signupSchema = z.object({
	username: usernameSchema,
	password: passwordSchema,
	accessCode: accessCodeSchema,
	turnstileToken: turnstileTokenSchema.optional()
})
