import { defineConsensusGroupSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1ConsensusGroupRepository } from '../../src/infrastructure/repositories/D1ConsensusGroupRepository'

// Cross-runtime parity for the consensus-GROUP library against the Worker's real D1 repository,
// inside workerd. The Node service runs the identical suite over Postgres — together they mandate
// the two stores behave the same, including that the optional scalars round-trip as ABSENT rather
// than null (which is what the strategy/rounds defaults key off).
defineConsensusGroupSuite('cloudflare', () => new D1ConsensusGroupRepository({ db: env.DB }))
