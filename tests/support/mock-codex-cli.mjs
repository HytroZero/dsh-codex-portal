import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const mode = process.env.MOCK_CODEX_AUTH ?? 'authenticated'

if (args[0] === '--version') {
  console.log('codex-cli 0.42.0-mock')
  process.exit(0)
}

if (args[0] === 'login' && args[1] === 'status') {
  if (mode !== 'authenticated') {
    console.error('Not logged in')
    process.exit(1)
  }
  console.log('Logged in using ChatGPT (mock@example.com)')
  process.exit(0)
}

if (args[0] === 'app-server') {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let reqId = 1000
  const pendingClientReqs = new Map()
  let activeTurn = null

  const send = (obj) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`)
  }

  const askClient = (method, params) => {
    const id = reqId++
    return new Promise((resolve) => {
      pendingClientReqs.set(id, resolve)
      send({ id, method, params })
    })
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return
    const msg = JSON.parse(line)

    if (msg.id !== undefined && !msg.method) {
      const resolver = pendingClientReqs.get(msg.id)
      if (resolver) {
        pendingClientReqs.delete(msg.id)
        resolver(msg.result)
      }
      return
    }

    const { id, method, params = {} } = msg
    if (method === 'initialize') {
      send({ id, result: { userAgent: 'codex-mock/0.42.0' } })
      return
    }
    if (method === 'initialized') return

    if (method === 'account/read') {
      send({
        id,
        result: mode === 'authenticated'
          ? { account: { type: 'chatgpt', email: 'mock@example.com', planType: 'pro' }, requiresOpenaiAuth: true }
          : { account: null, requiresOpenaiAuth: true },
      })
      return
    }

    if (method === 'model/list') {
      if (!params.cursor) {
        send({
          id,
          result: {
            data: [
              {
                id: 'gpt-5.4',
                model: 'gpt-5.4',
                displayName: 'GPT-5.4 (Codex)',
                description: 'Flagship coding model',
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Fast' },
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep' },
                ],
              },
            ],
            nextCursor: 'page-2',
          },
        })
      } else {
        send({
          id,
          result: {
            data: [
              {
                id: 'gpt-5.3-codex',
                model: 'gpt-5.3-codex',
                displayName: 'GPT-5.3 Codex',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep' },
                ],
              },
            ],
            nextCursor: null,
          },
        })
      }
      return
    }

    if (method === 'thread/start') {
      send({
        id,
        result: {
          thread: { id: 'thr_mock_1', cwd: params.cwd ?? process.cwd() },
          model: params.model ?? 'gpt-5.4',
        },
      })
      return
    }

    if (method === 'thread/resume') {
      send({
        id,
        result: {
          thread: { id: params.threadId ?? 'thr_mock_1', cwd: params.cwd ?? process.cwd() },
          model: params.model ?? 'gpt-5.4',
        },
      })
      return
    }

    if (method === 'turn/interrupt') {
      if (activeTurn) {
        activeTurn.interrupted = true
        send({
          method: 'turn/completed',
          params: { threadId: params.threadId, turn: { id: activeTurn.turnId, status: 'interrupted' } },
        })
        activeTurn = null
      }
      send({ id, result: {} })
      return
    }

    if (method === 'turn/start') {
      const turnId = `turn_${Date.now()}`
      const threadId = params.threadId
      const text = params.input?.[0]?.text ?? ''
      send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
      activeTurn = { threadId, turnId, interrupted: false }

      setImmediate(async () => {
        if (!activeTurn || activeTurn.turnId !== turnId) return
        send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: 'rs_1', delta: 'Thinking via Codex... ' } })

        if (text.includes('RUN_COMMAND')) {
          send({
            method: 'item/started',
            params: {
              threadId,
              turnId,
              item: { id: 'cmd_1', type: 'commandExecution', command: 'echo hello', cwd: process.cwd() },
            },
          })
          send({
            method: 'item/completed',
            params: {
              threadId,
              turnId,
              item: { id: 'cmd_1', type: 'commandExecution', command: 'echo hello', aggregatedOutput: 'hello\n', exitCode: 0, status: 'completed' },
            },
          })
        }

        if (text.includes('NEED_APPROVAL')) {
          const decision = await askClient('item/commandExecution/requestApproval', {
            threadId,
            turnId,
            itemId: 'cmd_auth',
            command: 'rm -rf tmp-cache',
            reason: 'Clear temporary cache',
          })
          if (!activeTurn || activeTurn.turnId !== turnId) return
          const approved = decision?.decision === 'accept'
          send({
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, itemId: 'msg_1', delta: approved ? 'Approved and executed.' : 'Declined by user.' },
          })
          send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
          activeTurn = null
          return
        }

        if (text.includes('NEED_INPUT')) {
          const reply = await askClient('item/tool/requestUserInput', {
            threadId,
            turnId,
            itemId: 'ask_1',
            questions: [
              {
                id: 'env',
                header: 'Environment',
                question: 'Which environment?',
                options: [
                  { label: 'staging', description: 'Staging cluster' },
                  { label: 'prod', description: 'Production cluster' },
                ],
              },
            ],
          })
          if (!activeTurn || activeTurn.turnId !== turnId) return
          const chosen = reply?.answers?.env?.answers?.join(', ') ?? 'none'
          send({
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, itemId: 'msg_1', delta: `Selected: ${chosen}` },
          })
          send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
          activeTurn = null
          return
        }

        if (text.includes('SLOW_TURN')) {
          await new Promise(r => setTimeout(r, 3000))
          if (!activeTurn || activeTurn.turnId !== turnId) return
        }

        send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: 'msg_1', delta: `Codex(${params.model ?? 'default'}): ${text}` },
        })
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
        activeTurn = null
      })
      return
    }

    send({ id, error: { code: -32601, message: `Unknown method ${method}` } })
  })
}
