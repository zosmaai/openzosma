"use client"

import filesService from "@/src/services/files.services"
import type { FileEntry } from "@/src/services/files.services"
import { QUERY_KEYS } from "@/src/utils/query-keys"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

/**
 * Fetch the full recursive file tree for the current user.
 */
export const useFileTree = () => {
	return useQuery<FileEntry[]>({
		queryKey: [QUERY_KEYS.FILES_TREE],
		queryFn: () => filesService.getTree(),
	})
}

/**
 * List files/folders under a specific directory path.
 */
export const useFileList = (dirPath?: string) => {
	return useQuery<FileEntry[]>({
		queryKey: [QUERY_KEYS.FILES_LIST, dirPath ?? "/"],
		queryFn: () => filesService.listFiles(dirPath),
	})
}

/**
 * Upload files to a given directory path. Invalidates tree + list queries on success.
 */
export const useUploadFiles = () => {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: ({ files, dirPath }: { files: File[]; dirPath?: string }) => filesService.uploadFiles(files, dirPath),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_TREE] })
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_LIST] })
		},
	})
}

/**
 * Create a new folder at a given path. Invalidates tree + list queries on success.
 */
export const useCreateFolder = () => {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (path: string) => filesService.createFolder(path),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_TREE] })
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_LIST] })
		},
	})
}

/**
 * Rename or move a file/folder. Invalidates tree + list queries on success.
 */
export const useRenameFile = () => {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: ({ from, to }: { from: string; to: string }) => filesService.renameFile(from, to),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_TREE] })
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_LIST] })
		},
	})
}

/**
 * Delete a file or folder by path. Invalidates tree + list queries on success.
 */
export const useDeleteFile = () => {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (path: string) => filesService.deleteFile(path),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_TREE] })
			queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.FILES_LIST] })
		},
	})
}
