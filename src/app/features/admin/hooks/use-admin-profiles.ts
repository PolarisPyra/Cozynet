import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/app/shared/utils"

export interface AdminGameProfile extends Record<string, unknown> {
	version: number
	userName?: string
	playerRating?: number
	level?: number
}

export interface AdminUserProfiles {
	chunithm: AdminGameProfile[]
	ongeki: AdminGameProfile[]
	maimaidx: AdminGameProfile[]
}

export function useAdminUserProfiles(userId: number | null) {
	return useQuery({
		queryKey: ["admin-user-profiles", userId],
		queryFn: async () => {
			if (!userId) return null
			const res = await api.admin.users[":id"].profiles.$get({
				param: { id: userId.toString() }
			})
			if (!res.ok) throw new Error("Failed to fetch profiles")
			return (await res.json()) as AdminUserProfiles
		},
		enabled: !!userId
	})
}

export function useUpdateAdminUserProfile() {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: async ({
			userId,
			game,
			version,
			data
		}: {
			userId: number
			game: string
			version: number
			data: Record<string, unknown>
		}) => {
			const res = await api.admin.users[":id"].profiles[":game"][":version"].$put({
				param: {
					id: userId.toString(),
					game,
					version: version.toString()
				},
				json: data as Record<string, string | number | boolean | null>
			})
			if (!res.ok) throw new Error("Failed to update profile")
			return await res.json()
		},
		onSuccess: (_, variables) => {
			toast.success("Profile updated successfully")
			queryClient.invalidateQueries({ queryKey: ["admin-user-profiles", variables.userId] })
		},
		onError: error => {
			toast.error(error.message || "Failed to update profile")
		}
	})
}
