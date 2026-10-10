import { defineMergeTrackRecordSuite } from '@cat-factory/conformance'
import { harness } from './conformanceHarness'

// Merge track record: the classification → per-class rule → merge → effort tag → per-class SQL
// rollup chain must behave identically on D1 and Postgres.
defineMergeTrackRecordSuite(harness)
