import { json } from 'http-responders'
import { migrate } from './lib/migrate.js'
import getRawBody from 'raw-body'
import assert from 'http-assert'
import toCamelCase from 'to-camel-case'

const handler = async (req, res, client) => {
  const segs = req.url.split('/').filter(Boolean)
  if (segs[0] === 'retrievals' && req.method === 'POST') {
    await createRetrieval(res, client)
  } else if (segs[0] === 'retrievals' && req.method === 'PATCH') {
    await setRetrievalResult(req, res, client, Number(segs[1]))
  } else {
    res.end('Hello World!')
  }
}

const createRetrieval = async (res, client) => {
  // TODO: Consolidate to one query
  const { rows: [retrievalTemplate] } = await client.query(`
    SELECT id, cid, provider_address, protocol
    FROM retrieval_templates
    OFFSET floor(random() * (SELECT COUNT(*) FROM retrieval_templates))
    LIMIT 1
  `)
  const { rows: [retrieval] } = await client.query(`
    INSERT INTO retrievals (retrieval_template_id)
    VALUES ($1)
    RETURNING id
  `, [
    retrievalTemplate.id
  ])
  json(res, {
    id: retrieval.id,
    cid: retrievalTemplate.cid,
    providerAddress: retrievalTemplate.provider_address,
    protocol: retrievalTemplate.protocol
  })
}

const setRetrievalResult = async (req, res, client, retrievalId) => {
  assert(!Number.isNaN(retrievalId), 400, 'Invalid Retrieval ID')
  const body = await getRawBody(req, { limit: '100kb' })
  const result = JSON.parse(body)
  try {
    await client.query(`
      INSERT INTO retrieval_results
      (retrieval_id, wallet_address, success)
      VALUES ($1, $2, $3)
    `, [
      retrievalId,
      result.walletAddress,
      result.success
    ])
  } catch (err) {
    if (err.constraint === 'retrieval_results_retrieval_id_fkey') {
      assert.fail(404, 'Retrieval Not Found')
    } else if (err.constraint === 'retrieval_results_pkey') {
      assert.fail(409, 'Retrieval Already Completed')
    } else if (err.column) {
      assert.fail(400, `Invalid .${toCamelCase(err.column)}`)
    } else {
      throw err
    }
  }
  res.end('OK')
}

const errorHandler = (res, err) => {
  if (err instanceof SyntaxError) {
    res.statusCode = 400
    return res.end('Invalid JSON Body')
  } else if (err.statusCode) {
    res.statusCode = err.statusCode
    res.end(err.message)
  } else {
    console.error(err)
    res.statusCode = 500
    res.end('Internal Server Error')
  }
}

export const createHandler = async (client) => {
  await migrate(client)
  return (req, res) => {
    handler(req, res, client).catch(err => errorHandler(res, err))
  }
}
