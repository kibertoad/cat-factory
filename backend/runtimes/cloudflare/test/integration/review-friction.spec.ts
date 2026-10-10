import { defineReviewFrictionSuite } from '@cat-factory/conformance'
import { harness } from './conformanceHarness'

// Opt-in review-debt friction: the four settings columns + the board's friction guard must gate
// task creation identically on D1 and Postgres.
defineReviewFrictionSuite(harness)
