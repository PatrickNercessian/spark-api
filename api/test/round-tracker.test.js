import assert from 'node:assert'
import pg from 'pg'
import {
  TASKS_PER_ROUND,
  getRoundStartEpoch,
  mapCurrentMeridianRoundToSparkRound,
  startRoundTracker
} from '../lib/round-tracker.js'
import { migrate } from '../../migrations/index.js'
import { assertApproximately } from '../../test-helpers/assert.js'
import { createMeridianContract } from '../lib/ie-contract.js'
import { afterEach, beforeEach } from 'mocha'

const { DATABASE_URL } = process.env

const TIMEOUT_WHEN_QUERYING_CHAIN = (process.env.CI ? 10 : 1) * 60_000

describe('Round Tracker', () => {
  /** @type {pg.Pool} */
  let pgPool
  /** @type {pg.PoolClient} */
  let pgClient

  before(async () => {
    pgPool = new pg.Pool({ connectionString: DATABASE_URL })
    pgClient = await pgPool.connect()
    await migrate(pgClient)
  })

  after(async () => {
    pgClient.release()
    await pgPool.end()
  })

  beforeEach(async () => {
    await pgClient.query('DELETE FROM meridian_contract_versions')
    await pgClient.query('DELETE FROM retrieval_tasks')
    await pgClient.query('DELETE FROM spark_rounds')
  })

  /** @type {AbortController} */
  let testFinished
  beforeEach(async () => {
    testFinished = new AbortController()
  })
  afterEach(async () => {
    testFinished.abort('test finished')
  })

  describe('mapCurrentMeridianRoundToSparkRound', () => {
    it('handles meridian rounds from the same contract', async () => {
      let sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress: '0x1a',
        meridianRoundIndex: 120n,
        roundStartEpoch: 321n,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 1n)
      let sparkRounds = (await pgClient.query('SELECT * FROM spark_rounds ORDER BY id')).rows
      assert.deepStrictEqual(sparkRounds.map(r => r.id), ['1'])
      assertApproximately(sparkRounds[0].created_at, new Date(), 30_000)
      assert.strictEqual(sparkRounds[0].meridian_address, '0x1a')
      assert.strictEqual(sparkRounds[0].meridian_round, '120')

      // first round number was correctly initialised
      assert.strictEqual(await getFirstRoundForContractAddress(pgClient, '0x1a'), '1')

      sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress: '0x1a',
        meridianRoundIndex: 121n,
        roundStartEpoch: 321n,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 2n)
      sparkRounds = (await pgClient.query('SELECT * FROM spark_rounds ORDER BY id')).rows
      assert.deepStrictEqual(sparkRounds.map(r => r.id), ['1', '2'])
      assertApproximately(sparkRounds[1].created_at, new Date(), 30_000)
      assert.strictEqual(sparkRounds[1].meridian_address, '0x1a')
      assert.strictEqual(sparkRounds[1].meridian_round, '121')

      // first round number was not changed
      assert.strictEqual(await getFirstRoundForContractAddress(pgClient, '0x1a'), '1')
    })

    it('handles deployment of a new smart contract', async () => {
      // First contract version `0x1a`
      let sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress: '0x1a',
        meridianRoundIndex: 120n,
        roundStartEpoch: 321n,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 1n)

      // New contract version `0x1b`
      sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress: '0x1b',
        meridianRoundIndex: 10n,
        roundStartEpoch: 321n,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 2n)

      // first round number was correctly initialised
      assert.strictEqual(await getFirstRoundForContractAddress(pgClient, '0x1b'), '2')

      const { rows: [round2] } = await pgClient.query('SELECT * FROM spark_rounds WHERE id = 2')
      assert.strictEqual(round2.meridian_address, '0x1b')
      assert.strictEqual(round2.meridian_round, '10')

      // Double check that the next meridian round will map correctly
      // New contract version `0x1b`
      sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress: '0x1b',
        meridianRoundIndex: 11n,
        roundStartEpoch: 321n,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 3n)

      const { rows: [round3] } = await pgClient.query('SELECT * FROM spark_rounds WHERE id = 3')
      assert.strictEqual(round3.meridian_address, '0x1b')
      assert.strictEqual(round3.meridian_round, '11')

      // first round number was not changed
      assert.strictEqual(await getFirstRoundForContractAddress(pgClient, '0x1b'), '2')
    })

    it('handles duplicate RoundStarted event', async () => {
      const now = new Date()
      const meridianRoundIndex = 1n
      const meridianContractAddress = '0x1a'
      const roundStartEpoch = 321n

      let sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress,
        meridianRoundIndex,
        roundStartEpoch,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 1n)
      let sparkRounds = (await pgClient.query('SELECT * FROM spark_rounds ORDER BY id')).rows
      assert.deepStrictEqual(sparkRounds.map(r => r.id), ['1'])
      assertApproximately(sparkRounds[0].created_at, now, 30_000)
      assert.strictEqual(sparkRounds[0].meridian_address, '0x1a')
      assert.strictEqual(sparkRounds[0].meridian_round, '1')

      sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress,
        meridianRoundIndex,
        roundStartEpoch,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 1n)
      sparkRounds = (await pgClient.query('SELECT * FROM spark_rounds ORDER BY id')).rows
      assert.deepStrictEqual(sparkRounds.map(r => r.id), ['1'])
      assertApproximately(sparkRounds[0].created_at, now, 30_000)
      assert.strictEqual(sparkRounds[0].meridian_address, '0x1a')
      assert.strictEqual(sparkRounds[0].meridian_round, '1')
    })

    it('creates tasks when a new round starts', async () => {
      const sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress: '0x1a',
        meridianRoundIndex: 1n,
        roundStartEpoch: 321n,
        pgClient
      })

      const { rows: tasks } = await pgClient.query('SELECT * FROM retrieval_tasks ORDER BY id')
      assert.strictEqual(tasks.length, TASKS_PER_ROUND)
      for (const [ix, t] of tasks.entries()) {
        assert.strictEqual(BigInt(t.round_id), sparkRoundNumber)
        assert.strictEqual(typeof t.cid, 'string', `task#${ix} cid`)
        // node-pg maps SQL value `NULL` to JS value `null`
        assert.strictEqual(t.provider_address, null, `task#${ix} provider_address`)
        assert.strictEqual(t.protocol, null, `task#${ix} protocol`)
        assert.match(t.miner_id, /^f0/, `task#${ix} miner_id should match /^f0/, found ${t.miner_id}`)
      }
    })

    it('creates tasks only once per round', async () => {
      const meridianRoundIndex = 1n
      const meridianContractAddress = '0x1a'
      const roundStartEpoch = 321n

      const firstRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress,
        meridianRoundIndex,
        roundStartEpoch,
        pgClient
      })
      const secondRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress,
        meridianRoundIndex,
        roundStartEpoch,
        pgClient
      })
      assert.strictEqual(firstRoundNumber, secondRoundNumber)

      const { rows: tasks } = await pgClient.query('SELECT * FROM retrieval_tasks ORDER BY id')
      assert.strictEqual(tasks.length, TASKS_PER_ROUND)
      for (const t of tasks) {
        assert.strictEqual(BigInt(t.round_id), firstRoundNumber)
      }
    })

    it('sets tasks_per_round', async () => {
      const meridianRoundIndex = 1n
      const meridianContractAddress = '0x1a'
      const roundStartEpoch = 321n

      const sparkRoundNumber = await mapCurrentMeridianRoundToSparkRound({
        meridianContractAddress,
        meridianRoundIndex,
        roundStartEpoch,
        pgClient
      })
      assert.strictEqual(sparkRoundNumber, 1n)
      const sparkRounds = (await pgClient.query('SELECT * FROM spark_rounds ORDER BY id')).rows
      assert.deepStrictEqual(sparkRounds.map(r => r.id), ['1'])
      assert.strictEqual(sparkRounds[0].max_tasks_per_node, 15)
    })
  })

  describe('getRoundStartEpoch', () => {
    it('returns a block number', async function () {
      this.timeout(TIMEOUT_WHEN_QUERYING_CHAIN)
      const contract = await createMeridianContract()
      const roundIndex = await contract.currentRoundIndex()
      const startEpoch = await getRoundStartEpoch(contract, roundIndex)
      assert.strictEqual(typeof startEpoch, 'number')
    })
  })

  describe('startRoundTracker', () => {
    it('detects the current round', async function () {
      this.timeout(TIMEOUT_WHEN_QUERYING_CHAIN)
      const { sparkRoundNumber } = await startRoundTracker({ pgPool, signal: testFinished.signal })
      assert.strictEqual(typeof sparkRoundNumber, 'bigint')
    })
  })
})

const getFirstRoundForContractAddress = async (pgClient, contractAddress) => {
  const { rows } = await pgClient.query(
    'SELECT first_spark_round_number FROM meridian_contract_versions WHERE contract_address = $1',
    [contractAddress]
  )
  return rows?.[0]?.first_spark_round_number
}
