import { Hono } from "hono"
import type { ResultSetHeader } from "mysql2"
import { z } from "zod"

import db from "@/server/db"
import { validateJson } from "@/server/middleware/validator"
import { rethrowWithMessage } from "@/server/utils/error"
import { DaphnisUserOptionKey } from "@/app/shared/types"

const ChunithmModsRoutes = new Hono()

	.post(
		"songs/unlock",
		validateJson(
			z.object({
				value: z.number()
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { value } = c.req.valid("json")

				const [update] = await db.execute<ResultSetHeader>(
					`
					UPDATE cozynet_user_option
             		SET value = ?
		    		WHERE user = ? AND \`key\` = '${DaphnisUserOptionKey.UnlockAllSongs}'
				`,
					[value, userId]
				)

				if (update.affectedRows === 0) {
					await db.execute<ResultSetHeader>(`INSERT INTO cozynet_user_option (user, \`key\`, value) VALUES (?, ?, ?)`, [
						userId,
						DaphnisUserOptionKey.UnlockAllSongs,
						value
					])
				}

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to add favorite", error)
			}
		}
	)

	.post(
		"songs/lock",
		validateJson(
			z.object({
				value: z.number()
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { value } = c.req.valid("json")

				const [update] = await db.execute<ResultSetHeader>(
					`
					UPDATE cozynet_user_option
             		SET value = ?
             		WHERE user = ? AND \`key\` = '${DaphnisUserOptionKey.UnlockAllSongs}'
				`,
					[value, userId]
				)

				if (update.affectedRows === 0) {
					await db.execute<ResultSetHeader>(`INSERT INTO cozynet_user_option (user, \`key\`, value) VALUES (?, ?, ?)`, [
						userId,
						DaphnisUserOptionKey.UnlockAllSongs,
						value
					])
				}

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to add favorite", error)
			}
		}
	)

	.post(
		"tickets/unlimited",
		validateJson(
			z.object({
				value: z.number()
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { value } = c.req.valid("json")

				const [update] = await db.execute<ResultSetHeader>(
					`
					UPDATE cozynet_user_option
             		SET value = ?
             		WHERE user = ? AND \`key\` = '${DaphnisUserOptionKey.MaxTickets}'
				`,
					[value, userId]
				)

				if (update.affectedRows === 0) {
					await db.execute<ResultSetHeader>(`INSERT INTO cozynet_user_option (user, \`key\`, value) VALUES (?, ?, ?)`, [
						userId,
						DaphnisUserOptionKey.MaxTickets,
						value
					])
				}

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to add favorite", error)
			}
		}
	)

	.post(
		"tickets/limited",
		validateJson(
			z.object({
				value: z.number()
			})
		),
		async c => {
			try {
				const { userId } = c.payload
				const { value } = c.req.valid("json")

				const [update] = await db.execute<ResultSetHeader>(
					`
					UPDATE cozynet_user_option
             		SET value = ?
             		WHERE user = ? AND \`key\` = '${DaphnisUserOptionKey.MaxTickets}'
				`,
					[value, userId]
				)

				if (update.affectedRows === 0) {
					await db.execute<ResultSetHeader>(`INSERT INTO cozynet_user_option (user, \`key\`, value) VALUES (?, ?, ?)`, [
						userId,
						DaphnisUserOptionKey.MaxTickets,
						value
					])
				}

				return c.json({ success: true })
			} catch (error) {
				throw rethrowWithMessage("Failed to add favorite", error)
			}
		}
	)
export { ChunithmModsRoutes }
