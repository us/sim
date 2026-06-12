import { createLogger } from '@sim/logger'
import { decodeVfsPathSegments, encodeVfsPathSegments } from '@/lib/copilot/vfs/path-utils'
import { resolveWorkflowAliasForWorkspace } from '@/lib/copilot/vfs/workflow-alias-resolver'
import { isPlanAliasPath, workflowAliasSandboxPath } from '@/lib/copilot/vfs/workflow-aliases'
import { isMothershipBetaFeaturesEnabled } from '@/lib/core/config/feature-flags'
import { buildNameById, rowDataIdToName } from '@/lib/table/column-keys'
import { toCsvRow } from '@/lib/table/export-format'
import { getTableById, listTables, selectExportRowPage } from '@/lib/table/service'
import type { TableDefinition } from '@/lib/table/types'
import { listWorkspaceFileFolders } from '@/lib/uploads/contexts/workspace/workspace-file-folder-manager'
import {
  fetchWorkspaceFileBuffer,
  findWorkspaceFileRecord,
  getSandboxWorkspaceFilePath,
  listWorkspaceFiles,
} from '@/lib/uploads/contexts/workspace/workspace-file-manager'
import { executeTool as executeAppTool } from '@/tools'
import type { ToolExecutionContext, ToolExecutionResult } from '../../tool-executor/types'

const logger = createLogger('CopilotFunctionExecute')

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_TOTAL_SIZE = 50 * 1024 * 1024
const MAX_MOUNTED_FILES = 500

interface SandboxFile {
  path: string
  content: string
  encoding?: 'base64'
}

interface CanonicalFileInput {
  path: string
  sandboxPath?: string
}

interface CanonicalDirectoryInput {
  path: string
  sandboxPath?: string
}

interface CanonicalTableInput {
  tableId?: string
  path?: string
  sandboxPath?: string
}

function tableNameFromVfsPath(tableRef: string): string | null {
  if (!tableRef.startsWith('tables/')) return null
  const segments = decodeVfsPathSegments(tableRef)
  const metaIndex = segments.lastIndexOf('meta.json')
  return segments[metaIndex > 0 ? metaIndex - 1 : segments.length - 1] ?? null
}

async function resolveTableRef(
  tableRef: string,
  tablePathLookup?: Map<string, Awaited<ReturnType<typeof listTables>>[number]>
) {
  if (!tableRef.startsWith('tables/')) {
    return getTableById(tableRef)
  }

  const tableName = tableNameFromVfsPath(tableRef)
  if (!tableName) return null
  return tablePathLookup?.get(tableName) ?? null
}

const TABLE_MOUNT_PAGE_SIZE = 5000

/**
 * Serializes a cell for a sandbox CSV mount. Unlike export downloads this skips
 * formula neutralization — the CSV is consumed by code, and a prefixed `'`
 * would corrupt values.
 */
function formatMountCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Serializes a full table to CSV for a sandbox mount. Walks the keyset export
 * reader page by page so every row is included (`queryRows` with defaults
 * silently truncated mounts to its 100-row page and paid for a count and
 * execution metadata the CSV never used), and remaps stored column-id keys
 * back to display names so headers line up with cell values.
 */
async function buildTableCsvForMount(table: TableDefinition): Promise<string> {
  const nameById = buildNameById(table.schema)
  const headers = table.schema.columns.map((c) => c.name)
  const lines = [toCsvRow(headers)]
  let after: { position: number; id: string } | null = null
  while (true) {
    const page = await selectExportRowPage(table, after, TABLE_MOUNT_PAGE_SIZE)
    for (const row of page) {
      const data = rowDataIdToName(row.data, nameById)
      lines.push(toCsvRow(headers.map((header) => formatMountCsvValue(data[header]))))
    }
    if (page.length < TABLE_MOUNT_PAGE_SIZE) return lines.join('\n')
    const last = page[page.length - 1]
    after = { position: last.position, id: last.id }
  }
}

async function resolveInputFiles(
  workspaceId: string,
  inputFiles?: unknown[],
  inputTables?: unknown[],
  inputDirectories?: unknown[]
): Promise<SandboxFile[]> {
  const sandboxFiles: SandboxFile[] = []
  let totalSize = 0

  if (inputFiles?.length && workspaceId) {
    const allFiles = await listWorkspaceFiles(workspaceId, {
      includeReservedSystemFiles: isMothershipBetaFeaturesEnabled,
    })
    for (const fileRef of inputFiles) {
      const filePath =
        typeof fileRef === 'string'
          ? fileRef
          : fileRef && typeof fileRef === 'object'
            ? (fileRef as CanonicalFileInput).path
            : undefined
      if (!filePath) continue
      const alias = await resolveWorkflowAliasForWorkspace({ workspaceId, path: filePath })
      if (!alias && isPlanAliasPath(filePath)) {
        logger.warn('Unsupported plan alias input file path', { filePath })
        continue
      }
      if (alias?.kind === 'plans_dir') {
        logger.warn('Input file is a plan alias directory', { filePath })
        continue
      }
      const record = findWorkspaceFileRecord(allFiles, alias?.backingPath ?? filePath)
      if (!record) {
        if (filePath.startsWith('uploads/')) {
          throw new Error(
            `Cannot mount "${filePath}": uploads/ files are not mountable into the sandbox. Use materialize_file to save it to a files/... path first, then mount that canonical path.`
          )
        }
        throw new Error(
          `Input file not found: "${filePath}". Pass the exact canonical VFS path copied from glob/read (e.g. "files/Reports/data.csv").`
        )
      }
      if (record.size > MAX_FILE_SIZE) {
        throw new Error(
          `Input file "${filePath}" is ${Math.round(record.size / 1024 / 1024)}MB, over the ${MAX_FILE_SIZE / 1024 / 1024}MB per-file mount limit.`
        )
      }
      if (totalSize + record.size > MAX_TOTAL_SIZE) {
        throw new Error(
          `Mounting "${filePath}" would exceed the ${MAX_TOTAL_SIZE / 1024 / 1024}MB total mount limit. Mount fewer or smaller files.`
        )
      }
      const buffer = await fetchWorkspaceFileBuffer(record)
      totalSize += buffer.length
      const isText = /^text\/|application\/json|application\/xml|application\/csv/.test(
        record.type || ''
      )
      const content = isText ? buffer.toString('utf-8') : buffer.toString('base64')
      const explicitSandboxPath =
        typeof fileRef === 'object' && fileRef !== null
          ? (fileRef as CanonicalFileInput).sandboxPath
          : undefined
      sandboxFiles.push({
        path:
          explicitSandboxPath ||
          (alias ? workflowAliasSandboxPath(alias.aliasPath) : getSandboxWorkspaceFilePath(record)),
        content,
        encoding: isText ? undefined : 'base64',
      })
    }
  }

  if (inputDirectories?.length && workspaceId) {
    const folders = await listWorkspaceFileFolders(workspaceId, {
      includeReservedSystemFolders: isMothershipBetaFeaturesEnabled,
    })
    const allFiles = await listWorkspaceFiles(workspaceId, {
      folders,
      includeReservedSystemFiles: isMothershipBetaFeaturesEnabled,
    })
    for (const dirRef of inputDirectories) {
      const dirPath =
        typeof dirRef === 'string'
          ? dirRef
          : dirRef && typeof dirRef === 'object'
            ? (dirRef as CanonicalDirectoryInput).path
            : undefined
      if (!dirPath) continue
      const alias = await resolveWorkflowAliasForWorkspace({ workspaceId, path: dirPath })
      if (alias && alias.kind !== 'plans_dir') {
        throw new Error(`Input directory is a plan alias file, not a directory: ${dirPath}`)
      }
      if (!alias && isPlanAliasPath(dirPath)) {
        throw new Error(`Unsupported plan alias directory: ${dirPath}`)
      }
      const backingDirPath = alias?.backingPath ?? dirPath
      const folderSegments = decodeVfsPathSegments(backingDirPath.replace(/^\/?files\/?/, ''))
      const folderDisplayPath = folderSegments.join('/')
      const folder = folders.find((candidate) => candidate.path === folderDisplayPath)
      if (!folder) {
        throw new Error(`Input directory not found: ${dirPath}`)
      }
      const mountRoot =
        typeof dirRef === 'object' &&
        dirRef !== null &&
        (dirRef as CanonicalDirectoryInput).sandboxPath
          ? (dirRef as CanonicalDirectoryInput).sandboxPath!
          : alias
            ? workflowAliasSandboxPath(alias.aliasPath)
            : `/home/user/files/${encodeVfsPathSegments(folder.path.split('/'))}`
      const descendants = allFiles.filter((file) => {
        if (!file.folderPath) return false
        return file.folderPath === folder.path || file.folderPath.startsWith(`${folder.path}/`)
      })
      if (descendants.length > MAX_MOUNTED_FILES) {
        throw new Error(
          `Input directory contains too many files (${descendants.length}). Maximum is ${MAX_MOUNTED_FILES}. Mount a smaller directory or individual files.`
        )
      }
      logger.info('Mounting workspace directory for function_execute', {
        vfsPath: dirPath,
        sandboxPath: mountRoot,
        fileCount: descendants.length,
      })
      const childFolders = folders.filter(
        (candidate) =>
          candidate.path !== folder.path && candidate.path.startsWith(`${folder.path}/`)
      )
      if (descendants.length === 0 && childFolders.length === 0) {
        sandboxFiles.push({ path: `${mountRoot}/.keep`, content: '' })
        continue
      }
      for (const childFolder of childFolders) {
        const hasFiles = descendants.some((file) => {
          if (!file.folderPath) return false
          return (
            file.folderPath === childFolder.path ||
            file.folderPath.startsWith(`${childFolder.path}/`)
          )
        })
        if (!hasFiles) {
          const relativeFolder = childFolder.path.slice(folder.path.length).replace(/^\/+/, '')
          sandboxFiles.push({ path: `${mountRoot}/${relativeFolder}/.keep`, content: '' })
        }
      }
      for (const record of descendants) {
        if (record.size > MAX_FILE_SIZE) {
          throw new Error(`Input file exceeds size limit: ${record.name}`)
        }
        if (totalSize + record.size > MAX_TOTAL_SIZE) {
          throw new Error('Total input size limit exceeded while mounting directory')
        }
        const buffer = await fetchWorkspaceFileBuffer(record)
        totalSize += buffer.length
        const isText = /^text\/|application\/json|application\/xml|application\/csv/.test(
          record.type || ''
        )
        const relativeFolder =
          record.folderPath?.slice(folder.path.length).replace(/^\/+/, '') ?? ''
        const relativePath = alias
          ? encodeVfsPathSegments(
              [relativeFolder, record.name].filter(Boolean).join('/').split('/')
            )
          : [relativeFolder, record.name].filter(Boolean).join('/')
        sandboxFiles.push({
          path: `${mountRoot}/${relativePath}`,
          content: isText ? buffer.toString('utf-8') : buffer.toString('base64'),
          encoding: isText ? undefined : 'base64',
        })
      }
    }
  }

  if (inputTables?.length) {
    const hasTablePathRefs = inputTables.some((tableRef) => {
      const tableId =
        typeof tableRef === 'string'
          ? tableRef
          : tableRef && typeof tableRef === 'object'
            ? (tableRef as CanonicalTableInput).tableId || (tableRef as CanonicalTableInput).path
            : undefined
      return typeof tableId === 'string' && tableId.startsWith('tables/')
    })
    const tablePathLookup = hasTablePathRefs
      ? new Map((await listTables(workspaceId)).map((table) => [table.name, table]))
      : undefined
    const tableMounts = await Promise.all(
      inputTables.map(async (tableRef) => {
        const tableId =
          typeof tableRef === 'string'
            ? tableRef
            : tableRef && typeof tableRef === 'object'
              ? (tableRef as CanonicalTableInput).tableId || (tableRef as CanonicalTableInput).path
              : undefined
        if (!tableId) return null
        const table = await resolveTableRef(tableId, tablePathLookup)
        if (!table || table.workspaceId !== workspaceId) {
          throw new Error(
            `Input table not found: "${tableId}". Pass the table id (tbl_...) from tables/{name}/meta.json, or a tables/{name}/meta.json path.`
          )
        }
        const csvContent = await buildTableCsvForMount(table)
        const sandboxPath =
          typeof tableRef === 'object' && tableRef !== null
            ? (tableRef as CanonicalTableInput).sandboxPath
            : undefined
        return {
          path: sandboxPath || `/home/user/tables/${table.id}.csv`,
          content: csvContent,
        }
      })
    )
    for (const mount of tableMounts) {
      if (!mount) continue
      if (totalSize + mount.content.length > MAX_TOTAL_SIZE) {
        throw new Error(
          `Mounting table "${mount.path}" would exceed the ${MAX_TOTAL_SIZE / 1024 / 1024}MB total mount limit. Mount fewer or smaller tables.`
        )
      }
      totalSize += mount.content.length
      sandboxFiles.push(mount)
    }
  }

  return sandboxFiles
}

export async function executeFunctionExecute(
  params: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const enrichedParams = { ...params }

  if (context.decryptedEnvVars && Object.keys(context.decryptedEnvVars).length > 0) {
    enrichedParams.envVars = {
      ...context.decryptedEnvVars,
      ...((enrichedParams.envVars as Record<string, string>) || {}),
    }
  }

  if (context.workspaceId) {
    const inputs = enrichedParams.inputs as
      | {
          files?: CanonicalFileInput[]
          directories?: CanonicalDirectoryInput[]
          tables?: CanonicalTableInput[]
        }
      | undefined
    const inputFiles = [
      ...((enrichedParams.inputFiles as unknown[] | undefined) ?? []),
      ...(inputs?.files ?? []),
    ]
    const inputDirectories = inputs?.directories ?? []
    const inputTables = [
      ...((enrichedParams.inputTables as unknown[] | undefined) ?? []),
      ...(inputs?.tables ?? []),
    ]

    if (inputFiles?.length || inputTables?.length || inputDirectories.length) {
      const resolved = await resolveInputFiles(
        context.workspaceId,
        inputFiles,
        inputTables,
        inputDirectories
      )
      if (resolved.length > 0) {
        const existing = (enrichedParams._sandboxFiles as SandboxFile[]) || []
        enrichedParams._sandboxFiles = [...existing, ...resolved]
      }
    }
  }

  enrichedParams._context = {
    ...(typeof enrichedParams._context === 'object' && enrichedParams._context !== null
      ? (enrichedParams._context as object)
      : {}),
    userId: context.userId,
    workflowId: context.workflowId,
    workspaceId: context.workspaceId,
    chatId: context.chatId,
    executionId: context.executionId,
    runId: context.runId,
    enforceCredentialAccess: true,
  }

  return executeAppTool('function_execute', enrichedParams)
}
