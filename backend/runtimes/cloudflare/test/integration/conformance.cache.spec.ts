import { defineCacheSuite } from '@cat-factory/conformance'
import { harness } from './conformanceHarness'

// Caching initiative: the Worker serves the fragment catalog through the ISOLATE-SAFE
// (pass-through) profile — coherence must hold there exactly as it does through Node's live
// in-memory cache.
defineCacheSuite(harness)
