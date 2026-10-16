// The answers to the reads the add-task form sends when it opens: the fragment catalog, and the
// imported documents and tracker issues its attachment pickers list.
import {
  listDocumentsContract,
  listTasksContract,
  resolvedFragmentsContract,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import type { SourceTask } from '@cat-factory/contracts'
import { apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'
import { fragmentCatalog } from './fragments.stories.mocks'

const pathPrefix = storyWorkspacePrefix

export function taskFormApi({ issues = [] }: { issues?: SourceTask[] } = {}): HttpHandler[] {
  return [
    apiResponse(resolvedFragmentsContract, { pathPrefix, body: fragmentCatalog }),
    apiResponse(listDocumentsContract, { pathPrefix, body: [] }),
    apiResponse(listTasksContract, { pathPrefix, body: issues }),
  ]
}
