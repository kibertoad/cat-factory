// Issue-tracker write port. The tech-debt recurring pipeline's `tracker` step
// asks this provider to file a ticket (a GitHub issue or a Jira ticket) for the
// analysis it just produced, before implementation starts. The concrete provider
// resolves the workspace's tracker selection, credentials and (for GitHub) the
// service's repository itself; it returns null when no tracker is configured, so
// the step passes through.

export interface CreateTicketRequest {
  workspaceId: string
  /** The service frame the run belongs to (used to resolve the GitHub repo). */
  frameId: string
  title: string
  /** Markdown body (the analysis report). */
  body: string
}

/** The filed ticket. */
export interface CreatedTicket {
  /** Canonical external id (e.g. "owner/repo#123" or "ENG-42"). */
  externalId: string
  url: string
}

export interface TicketTrackerProvider {
  /** File a ticket, or return null when no tracker is configured for the workspace. */
  createTicket(request: CreateTicketRequest): Promise<CreatedTicket | null>
}
