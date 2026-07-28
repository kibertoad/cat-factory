// ---------------------------------------------------------------------------
// Bug hunt: pick a connected tracker + one of its boards, get its open and
// unassigned bugs ranked by impact against implementation complexity, then adopt
// one onto the board and run the bug-fix pipeline on it.
//
// The interactive dual of the recurring `bug-intake` step. All wire shapes are
// sourced from @cat-factory/contracts (single source of truth).
// ---------------------------------------------------------------------------

export type {
  TrackerBoard,
  TrackerBoardsView,
  BugCandidate,
  BugHuntAnalysis,
  BugHuntAnalysisStatus,
  BugHuntCandidate,
  BugHuntConfidence,
  BugHuntResult,
  RunBugHuntInput,
  AdoptBugHuntCandidateInput,
} from '@cat-factory/contracts'
