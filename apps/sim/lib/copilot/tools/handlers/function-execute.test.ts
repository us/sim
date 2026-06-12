/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetTableById, mockSelectExportRowPage, mockExecuteTool } = vi.hoisted(() => ({
  mockGetTableById: vi.fn(),
  mockSelectExportRowPage: vi.fn(),
  mockExecuteTool: vi.fn(),
}))

vi.mock('@/lib/table/service', () => ({
  getTableById: mockGetTableById,
  listTables: vi.fn(),
  selectExportRowPage: mockSelectExportRowPage,
}))

vi.mock('@/tools', () => ({
  executeTool: mockExecuteTool,
}))

vi.mock('@/lib/uploads/contexts/workspace/workspace-file-manager', () => ({
  fetchWorkspaceFileBuffer: vi.fn(),
  findWorkspaceFileRecord: vi.fn(),
  getSandboxWorkspaceFilePath: vi.fn(),
  listWorkspaceFiles: vi.fn(),
}))

vi.mock('@/lib/uploads/contexts/workspace/workspace-file-folder-manager', () => ({
  listWorkspaceFileFolders: vi.fn(),
}))

vi.mock('@/lib/copilot/vfs/workflow-alias-resolver', () => ({
  resolveWorkflowAliasForWorkspace: vi.fn(),
}))

import { executeFunctionExecute } from '@/lib/copilot/tools/handlers/function-execute'

const PAGE_SIZE = 5000

function buildTable() {
  return {
    id: 'tbl_1',
    name: 'People',
    description: null,
    schema: {
      columns: [
        { id: 'col_name', name: 'name', type: 'string' },
        { id: 'col_age', name: 'age', type: 'number' },
      ],
    },
    metadata: null,
    rowCount: PAGE_SIZE + 2,
    maxRows: 100000,
    workspaceId: 'workspace-1',
    createdBy: 'user-1',
    archivedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  }
}

function makeRows(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `row_${start + i}`,
    data: { col_name: `person ${start + i}`, col_age: start + i },
    position: start + i,
  }))
}

describe('executeFunctionExecute table mounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTableById.mockResolvedValue(buildTable())
    mockExecuteTool.mockResolvedValue({ success: true, output: {} })
  })

  it('drains every row through the keyset export reader, not a single 100-row page', async () => {
    mockSelectExportRowPage
      .mockResolvedValueOnce(makeRows(0, PAGE_SIZE))
      .mockResolvedValueOnce(makeRows(PAGE_SIZE, 2))

    await executeFunctionExecute(
      { code: 'print(1)', inputTables: ['tbl_1'] },
      { userId: 'user-1', workflowId: 'wf-1', workspaceId: 'workspace-1' }
    )

    expect(mockSelectExportRowPage).toHaveBeenCalledTimes(2)
    expect(mockSelectExportRowPage.mock.calls[0][1]).toBeNull()
    expect(mockSelectExportRowPage.mock.calls[1][1]).toEqual({
      position: PAGE_SIZE - 1,
      id: `row_${PAGE_SIZE - 1}`,
    })

    const params = mockExecuteTool.mock.calls[0][1] as {
      _sandboxFiles: Array<{ path: string; content: string }>
    }
    const mount = params._sandboxFiles.find((f) => f.path === '/home/user/tables/tbl_1.csv')
    expect(mount).toBeDefined()
    const lines = mount!.content.split('\n')
    expect(lines[0]).toBe('name,age')
    expect(lines).toHaveLength(1 + PAGE_SIZE + 2)
    expect(lines[1]).toBe('person 0,0')
    expect(lines[lines.length - 1]).toBe(`person ${PAGE_SIZE + 1},${PAGE_SIZE + 1}`)
  })

  it('maps stored column-id keys back to display-name headers', async () => {
    mockSelectExportRowPage.mockResolvedValueOnce([
      { id: 'row_1', data: { col_name: 'Alice', col_age: 30 }, position: 0 },
    ])

    await executeFunctionExecute(
      { code: 'print(1)', inputTables: ['tbl_1'] },
      { userId: 'user-1', workflowId: 'wf-1', workspaceId: 'workspace-1' }
    )

    const params = mockExecuteTool.mock.calls[0][1] as {
      _sandboxFiles: Array<{ path: string; content: string }>
    }
    expect(params._sandboxFiles[0].content).toBe('name,age\nAlice,30')
  })

  it('throws when the table belongs to a different workspace', async () => {
    mockGetTableById.mockResolvedValue({ ...buildTable(), workspaceId: 'workspace-other' })

    await expect(
      executeFunctionExecute(
        { code: 'print(1)', inputTables: ['tbl_1'] },
        { userId: 'user-1', workflowId: 'wf-1', workspaceId: 'workspace-1' }
      )
    ).rejects.toThrow(/Input table not found/)
    expect(mockExecuteTool).not.toHaveBeenCalled()
  })
})
