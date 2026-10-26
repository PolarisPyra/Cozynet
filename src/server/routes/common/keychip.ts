import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { z } from "zod"

import { DB } from "@/app/shared/types"
import { keychipSerialSchema } from "@/app/shared/types/validation/auth"
import { db } from "@/server/db"
import { validateJson, validateParams } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"

const KeychipRoutes = new Hono()
	.get("/", async c => {
		try {
			const { userId } = c.payload
			if (!userId) throw new HTTPException(403)

			// Get machines owned by user through arcade_owner
			const [machines] = await db.execute<
				(DB.Machine & { arcade_name: string | null; arcade_nickname: string | null } & RowDataPacket)[]
			>(
				`SELECT m.*, a.name as arcade_name, a.nickname as arcade_nickname
				FROM machine m
				INNER JOIN arcade_owner ao ON m.arcade = ao.arcade
				INNER JOIN arcade a ON m.arcade = a.id
				WHERE ao.user = ?
				ORDER BY m.id ASC`,
				[userId]
			)

			return c.json({ keychips: machines })
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch keychips", error)
		}
	})
	.get("/trusted", async c => {
		try {
			const { userId } = c.payload
			if (!userId) throw new HTTPException(403)

			// Get trusted keychips (machines trusted by this user)
			// Note: This might require a trust_keychip table - for now returning empty
			// You'll need to implement the trust mechanism based on your schema
			return c.json({ keychips: [] })
		} catch (error) {
			throw rethrowWithMessage("Failed to fetch trusted keychips", error)
		}
	})
	.post(
		"/rename",
		validateJson(
			z.object({
				keychipId: keychipSerialSchema,
				placeName: z.string().trim().min(1).max(20)
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { keychipId, placeName } = c.req.valid("json")

				if (!userId) throw new HTTPException(403)

				// Verify user owns this keychip
				const [machines] = await db.execute<(DB.Machine & RowDataPacket)[]>(
					`SELECT m.* FROM machine m
					INNER JOIN arcade_owner ao ON m.arcade = ao.arcade
					WHERE m.serial = ? AND ao.user = ? AND ao.permissions = 1`,
					[keychipId, userId]
				)

				if (machines.length === 0) {
					throw new HTTPException(404, { message: "Keychip not found or not owned by you" })
				}

				const machine = machines[0]

				// Update both arcade name and nickname
				await db.execute<ResultSetHeader>("UPDATE arcade SET name = ?, nickname = ? WHERE id = ?", [
					placeName,
					placeName,
					machine.arcade
				])

				return c.json({ success: true })
			} catch (error) {
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to rename keychip", error)
			}
		}
	)
	.delete(
		"/:id",
		validateParams(
			z.object({
				id: z.coerce.number().int().positive()
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { id: machineId } = c.req.valid("param")

				if (!userId) throw new HTTPException(403)

				// Verify user owns this keychip
				const [machines] = await db.execute<(DB.Machine & RowDataPacket)[]>(
					`SELECT m.* FROM machine m
				INNER JOIN arcade_owner ao ON m.arcade = ao.arcade
				WHERE m.id = ? AND ao.user = ? AND ao.permissions = 1`,
					[machineId, userId]
				)

				if (machines.length === 0) {
					throw new HTTPException(404, { message: "Keychip not found or not owned by you" })
				}

				const machine = machines[0]

				const conn = await db.getConnection()
				try {
					await conn.beginTransaction()

					// Delete machine
					await conn.execute<ResultSetHeader>("DELETE FROM machine WHERE id = ?", [machineId])

					// Delete arcade ownership and the arcade only if no other machines remain
					const [otherMachines] = await conn.execute<RowDataPacket[]>("SELECT id FROM machine WHERE arcade = ?", [
						machine.arcade
					])
					if (otherMachines.length === 0) {
						await conn.execute<ResultSetHeader>("DELETE FROM arcade_owner WHERE arcade = ?", [machine.arcade])
						await conn.execute<ResultSetHeader>("DELETE FROM arcade WHERE id = ?", [machine.arcade])
					}

					await conn.commit()
				} catch (error) {
					await conn.rollback()
					throw error
				} finally {
					conn.release()
				}

				return c.json({ success: true })
			} catch (error) {
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to remove keychip", error)
			}
		}
	)
	.post(
		"/add",
		validateJson(
			z.object({
				keychipId: keychipSerialSchema
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { keychipId } = c.req.valid("json")

				if (!userId) throw new HTTPException(403)

				// Find machine by serial
				const [machines] = await db.execute<(DB.Machine & RowDataPacket)[]>("SELECT * FROM machine WHERE serial = ?", [
					keychipId
				])

				if (machines.length === 0) {
					throw new HTTPException(404, { message: "Keychip not found" })
				}

				const machine = machines[0]

				// Add user as trusted owner (with lower permissions)
				// Check if already trusted
				const [existing] = await db.execute<RowDataPacket[]>(
					"SELECT * FROM arcade_owner WHERE user = ? AND arcade = ?",
					[userId, machine.arcade]
				)

				if (existing.length === 0) {
					await db.execute<ResultSetHeader>("INSERT INTO arcade_owner (user, arcade, permissions) VALUES (?, ?, ?)", [
						userId,
						machine.arcade,
						0
					])
				}

				return c.json({ success: true })
			} catch (error) {
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to add keychip", error)
			}
		}
	)
	.delete(
		"/delete",
		validateJson(
			z.object({
				keychipId: keychipSerialSchema
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { keychipId } = c.req.valid("json")

				if (!userId) throw new HTTPException(403)

				// Find machine by serial
				const [machines] = await db.execute<(DB.Machine & RowDataPacket)[]>("SELECT * FROM machine WHERE serial = ?", [
					keychipId
				])

				if (machines.length === 0) {
					throw new HTTPException(404, { message: "Keychip not found" })
				}

				const machine = machines[0]

				// Remove trusted ownership (only if permissions = 0, meaning trusted not owner)
				await db.execute<ResultSetHeader>(
					"DELETE FROM arcade_owner WHERE user = ? AND arcade = ? AND permissions = 0",
					[userId, machine.arcade]
				)

				return c.json({ success: true })
			} catch (error) {
				if (error instanceof HTTPException) throw error
				throw rethrowWithMessage("Failed to delete keychip", error)
			}
		}
	)

export { KeychipRoutes }
