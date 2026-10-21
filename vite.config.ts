import { webUpdateNotice } from "@plugin-web-update-notification/vite"
import tailwindcss from "@tailwindcss/vite"
import path from "path"
import { defineConfig, loadEnv } from "vite"

// Generate a random hash for cache busting
const buildHash = Math.floor(Math.random() * 90000) + 10000

const buildDateYearMonthDay = date => {
	const d = new Date(date)
	const year = d.getFullYear()
	const month = String(d.getMonth() + 1).padStart(2, "0")
	const day = String(d.getDate()).padStart(2, "0")
	return `${year}-${month}-${day}`
}

const buildTime12HourFormat = date => {
	const d = new Date(date)
	let hours = d.getHours()
	const minutes = String(d.getMinutes()).padStart(2, "0")
	const ampm = hours >= 12 ? "PM" : "AM"
	hours = hours % 12
	hours = hours ? hours : 12
	return `${hours}:${minutes} ${ampm}`
}

export default defineConfig(({ mode }) => {
	// Load environment variables based on the current mode
	const env = loadEnv(mode, process.cwd(), "")
	const isDev = mode === "development"

	return {
		ssr: {
			external: ["react", "react-dom"]
		},
		resolve: {
			alias: {
				"@": path.resolve(import.meta.dirname, "./src")
			},
			dedupe: ["react", "react-dom"],
			tsconfigPaths: true
		},
		build: {
			sourcemap: isDev,
			target: "esnext", // Use modern JS for better performance
			rollupOptions: {
				input: "./index.html",
				onwarn(warning, warn) {
					// Filter out specific warnings
					// "use client" is a React Server Components directive and has no effect in this SPA build
					if (
						warning.code === "MODULE_LEVEL_DIRECTIVE" ||
						warning.message.includes("Module level directives cause errors when bundled") ||
						warning.message.includes("Can't resolve original location of error")
					) {
						return
					}
					warn(warning)
				},
				output: {
					entryFileNames: `[name]-${buildHash}.js`,
					chunkFileNames: `assets/[name]-[hash]-${buildHash}.js`,
					assetFileNames: assetInfo => {
						// Keep images/fonts in organized folders
						const name = assetInfo.name || ""
						if (/\.(png|jpe?g|gif|svg|webp|avif)$/.test(name)) {
							return `assets/images/[name]-[hash]-${buildHash}[extname]`
						}
						if (/\.(woff2?|ttf|otf|eot)$/.test(name)) {
							return `assets/fonts/[name]-[hash]-${buildHash}[extname]`
						}
						return `assets/[name]-[hash]-${buildHash}[extname]`
					}
					// Removed manualChunks - let Vite handle chunking automatically for proper dependency ordering
				}
			},
			minify: "esbuild", // Explicitly set for clarity
			cssMinify: "esbuild",
			emptyOutDir: true,
			copyPublicDir: true,
			// Performance optimizations
			reportCompressedSize: false, // Faster builds
			chunkSizeWarningLimit: 1000 // Increase if you have large chunks
		},
		assetsInclude: ["**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.ttf", "**/*.woff", "**/*.woff2", "**/*.svg"],
		plugins: [
			tailwindcss(),
			webUpdateNotice({
				hiddenDefaultNotification: false,
				checkInterval: 60 * 1000,
				checkImmediately: true,
				checkOnLoadFileError: true,
				notificationProps: {
					title: "Site Update Available",
					description: "A new version is available. Please refresh to update.",
					buttonText: "Update Now",
					dismissButtonText: "Later"
				},
				// Add this to reduce console noise in production
				logVersion: isDev
			})
		],
		esbuild: {
			sourcemap: isDev,
			legalComments: "none", // Remove comments in production
			treeShaking: true
		},
		base: "/",
		server: {
			proxy: {
				"/api": {
					target: `http://${env.DOMAIN}:${env.SERVER_PORT}`,
					changeOrigin: true,
					secure: false,
					rewrite: path => path
				}
			},
			port: parseInt(env.CLIENT_PORT) || 3000,
			cors: {
				origin: true,
				credentials: true
			},
			host: true,
			strictPort: false // Allow fallback if port is busy
		},
		// Optimize dependency pre-bundling
		optimizeDeps: {
			include: ["react", "react-dom", "react-router-dom", "@tanstack/react-query", "date-fns", "lucide-react"],
			exclude: ["@plugin-web-update-notification/vite"]
		},
		define: {
			// For client env variables, add the type in src/vite-env.d.ts
			env: {
				TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY,
				BUILD_DATE_YEAR_MONTH_DAY: buildDateYearMonthDay(new Date().toISOString()),
				BUILD_TIME_12_HOUR: buildTime12HourFormat(new Date().toISOString()),
				CDN_URL: env.CDN_URL,
				USE_REACT_STRICT: env.NODE_ENV === "development",
				BUILD_HASH: buildHash
			}
		}
	}
})
