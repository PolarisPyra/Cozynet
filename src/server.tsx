/** @jsxImportSource hono/jsx */
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { rateLimiter } from "hono-rate-limiter"
import { compress } from "hono/compress"
import { cors } from "hono/cors"
import { csrf } from "hono/csrf"
import { HTTPException } from "hono/http-exception"
import { jsxRenderer } from "hono/jsx-renderer"
import { jwt } from "hono/jwt"
import { logger } from "hono/logger"
import { secureHeaders } from "hono/secure-headers"

import { jwtPayloadMiddleware } from "./server/middleware/jwtPayload"
import { Routes, UnprotectedRoutes } from "./server/routes"

const { NODE_ENV, CLIENT_PORT, DOMAIN, JWT_SECRET, SERVER_PORT } = process.env

const protocol = NODE_ENV === "production" ? "https" : "http"
const port = NODE_ENV === "production" ? "" : `:${CLIENT_PORT}`
const origin = `${protocol}://${DOMAIN}${port}`

const server = new Hono()
	.use(
		"*",
		cors({
			origin: [origin],
			credentials: true,
			allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"]
		})
	)
	.use(
		"*",
		csrf({
			origin: requestOrigin => {
				const allowedOrigins = [origin]
				return allowedOrigins.includes(requestOrigin)
			}
		})
	)
	.use(secureHeaders())
	.use(logger())
	.onError((err, c) => {
		if (err instanceof HTTPException) {
			return c.json({ error: err.message }, err.status)
		}

		const isProduction = process.env.NODE_ENV === "production"
		return c.json({ error: isProduction ? "Internal server error" : err.message }, 500)
	})
	.use(compress())

// Apply rate limiting to all API routes (only in production)
if (NODE_ENV === "production") {
	// Stricter limit for auth endpoints
	server.use(
		"/api/login",
		rateLimiter({
			windowMs: 15 * 60 * 1000, // 15 minutes
			limit: 10, // 10 attempts per 15 minutes
			standardHeaders: "draft-6",
			message: "Too many login attempts. Please try again later.",
			keyGenerator: c => {
				return c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "unknown"
			}
		})
	)

	server.use(
		"/api/signup",
		rateLimiter({
			windowMs: 60 * 60 * 1000, // 1 hour
			limit: 5, // 5 attempts per hour
			standardHeaders: "draft-6",
			message: "Too many signup attempts. Please try again later.",
			keyGenerator: c => {
				return c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "unknown"
			}
		})
	)

	// General API rate limit
	server.use(
		"/api/*",
		rateLimiter({
			windowMs: 1 * 60 * 1000, // 1 minute
			limit: 100, // 100 requests per minute
			standardHeaders: "draft-6",
			message: "Rate limit exceeded. Please slow down.",
			keyGenerator: c => {
				return c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "unknown"
			}
		})
	)
}

server
	.route("/api", UnprotectedRoutes)
	.use(jwt({ secret: JWT_SECRET!, cookie: "auth_token", alg: "HS256" }))
	.use(jwtPayloadMiddleware())
	.route("/api", Routes)
	.use("/public/*", serveStatic({ root: "./public" }))
	.use("/assets/*", serveStatic({ root: "./public/assets" }))
	.get(
		"/*",
		jsxRenderer(() => (
			<html lang="en">
				<head>
					<meta charSet="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>Thamyris</title>
				</head>
				<body>
					<div id="root"></div>
					<script type="module" src="/src/client.tsx"></script>
				</body>
			</html>
		))
	)

serve({
	fetch: server.fetch,
	port: Number(SERVER_PORT) || 3000
})

export default server
