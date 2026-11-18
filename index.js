/**
 * Draft completion — Host half.
 *
 * Serves one authenticated JSON route that rewrites the composer's current
 * draft into a more complete prompt with the deployment's selected model.
 * The Client half owns the button, the draft swap, and the revert affordance;
 * this half owns the model request and the credentials behind it, which never
 * reach the page.
 */

/** Absolute route path this plugin owns on the Web carrier. */
const ROUTE_PATH = '/plugin/draft-completion/complete'

/** Largest request body accepted, in bytes; the body carries one draft string. */
const BODY_LIMIT_BYTES = 64 * 1024

/** Default upper bound on draft characters accepted from one request. */
const DEFAULT_MAX_INPUT_CHARS = 8000

/** Default output-token cap for one completion request. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1200

/** Default sampling temperature; low enough to stay faithful to the draft. */
const DEFAULT_TEMPERATURE = 0.3

/** Default rewrite instructions, replaced by `config.systemPrompt` when supplied. */
const DEFAULT_SYSTEM_PROMPT = [
  'You rewrite a draft prompt into a complete, well-formed prompt for an AI coding assistant.',
  '',
  'Rules:',
  '- Keep the author\'s intent, language, and voice. Answer in the language of the draft.',
  '- Return only the rewritten prompt. No preface, no explanation, no meta commentary, and no surrounding quotes or code fences around the whole answer.',
  '- Preserve verbatim: file paths, URLs, commands, code snippets, identifiers, numbers, and @-mentions.',
  '- Remove vagueness the author clearly did not intend: name the concrete goal, the expected result, and the constraints that follow from the draft.',
  '- Add structure only where it helps, such as a one-line goal followed by requirements and acceptance criteria.',
  '- Do not invent requirements that change the goal, and do not answer the request.',
  '- Stay close to the draft in length. A terse draft may grow into a focused paragraph; a detailed draft stays detailed instead of ballooning.',
].join('\n')

/** Host services this plugin cannot serve requests without. */
export const inject = ['llm', 'webServer', 'connection', 'agentDefaultModel']

/**
 * Register the completion route.
 * @param ctx - Host context.
 * @param config - optional `maxInputChars`, `maxOutputTokens`, `temperature`, `systemPrompt`.
 * @returns nothing; the route is removed with this plugin.
 */
export function apply(ctx, config) {
  const settings = readSettings(config)
  const complete = createCompleter(ctx, settings)
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => { void respond(ctx, settings, complete, req, res) },
    }),
    'draft-completion: completion route',
  )
}

/**
 * Validate the optional patch configuration.
 * @param config - raw row configuration.
 * @returns immutable settings with defaults applied.
 */
function readSettings(config) {
  const value = config !== null && typeof config === 'object' ? config : {}
  return {
    maxInputChars: positiveInteger(value.maxInputChars, DEFAULT_MAX_INPUT_CHARS),
    maxOutputTokens: positiveInteger(value.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    temperature: finiteNumber(value.temperature, DEFAULT_TEMPERATURE),
    system: nonEmptyString(value.systemPrompt, DEFAULT_SYSTEM_PROMPT),
  }
}

/**
 * Answer one completion request.
 * @param ctx - Host context.
 * @param settings - resolved settings.
 * @param complete - model call bound to this plugin.
 * @param req - incoming HTTP request.
 * @param res - response owned until this handler settles.
 */
async function respond(ctx, settings, complete, req, res) {
  const rejection = ctx.connection.requestRejection({ headers: req.headers })
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST is required' } })
    return
  }

  let body
  try {
    body = await readJsonBody(req, BODY_LIMIT_BYTES)
  } catch (error) {
    send(res, 400, { ok: false, error: { code: 'invalid-body', message: messageOf(error) } })
    return
  }

  const draft = typeof body?.text === 'string' ? body.text : ''
  if (draft.trim() === '') {
    send(res, 400, { ok: false, error: { code: 'empty-draft', message: 'the draft is empty' } })
    return
  }
  if (draft.length > settings.maxInputChars) {
    send(res, 413, {
      ok: false,
      error: { code: 'draft-too-long', message: `the draft exceeds ${settings.maxInputChars} characters` },
    })
    return
  }

  const controller = new AbortController()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', onClose)
  try {
    const result = await complete(draft, controller.signal)
    send(res, 200, {
      ok: true,
      text: result.text,
      provider: result.provider,
      model: result.model,
      truncated: result.truncated,
    })
  } catch (error) {
    if (controller.signal.aborted) return
    send(res, 502, {
      ok: false,
      error: { code: errorCodeOf(error), message: messageOf(error) },
    })
  } finally {
    res.off('close', onClose)
  }
}

/**
 * Bind one one-shot model call to this plugin's settings and the current route.
 * @param ctx - Host context exposing the LLM and default-model services.
 * @param settings - resolved settings.
 * @returns function performing one rewrite.
 */
function createCompleter(ctx, settings) {
  return async function complete(draft, signal) {
    const selection = ctx.agentDefaultModel.currentSelection()
    const base = {
      provider: selection.provider,
      model: selection.model,
      system: settings.system,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: frame(draft) }],
      }],
      maxTokens: settings.maxOutputTokens,
      temperature: settings.temperature,
      signal,
    }
    const withEffort = selection.reasoningEffort === undefined
      ? base
      : { ...base, reasoningEffort: selection.reasoningEffort }
    try {
      return await collect(ctx, withEffort, selection)
    } catch (error) {
      // A remembered effort for a model that no longer accepts it must not cost
      // the author the click; the route's default effort serves the same purpose.
      if (error?.code !== 'UNSUPPORTED_REASONING_EFFORT' || withEffort === base) throw error
      return await collect(ctx, base, selection)
    }
  }
}

/**
 * Dispatch one request and assemble its visible text.
 * @param ctx - Host context exposing the LLM service.
 * @param options - complete request options.
 * @param selection - route the options name, recorded on the result.
 * @returns assembled text and route facts.
 */
async function collect(ctx, options, selection) {
  // Text blocks are keyed by stream index; `block-end` is authoritative for
  // the block it closes, so a route that omits deltas still yields text.
  const parts = new Map()
  let finish
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      parts.set(chunk.index ?? 0, (parts.get(chunk.index ?? 0) ?? '') + chunk.text)
    } else if (chunk.type === 'block-end') {
      const block = chunk.block
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.set(chunk.index ?? 0, block.text)
      }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }

  const kind = finish !== null && typeof finish === 'object' ? finish.kind : 'stop'
  if (kind === 'error' || kind === 'aborted') {
    const failure = finish?.failure ?? {}
    const error = new Error(typeof failure.message === 'string' ? failure.message : 'the model request failed')
    error.code = typeof failure.code === 'string' ? failure.code : kind.toUpperCase()
    throw error
  }

  const text = [...parts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, part]) => part)
    .join('')
    .trim()
  if (text === '') {
    const error = new Error('the model returned no text')
    error.code = 'EMPTY_RESPONSE'
    throw error
  }
  return { text, provider: selection.provider, model: selection.model, truncated: kind === 'max-tokens' }
}

/**
 * Wrap the draft in explicit markers so the model cannot confuse draft text
 * with instructions, without using fences it might echo.
 * @param draft - exact composer draft.
 * @returns user-role request text.
 */
function frame(draft) {
  return ['Rewrite the draft prompt between the markers below.', '', '<<<DRAFT', draft, 'DRAFT>>>'].join('\n')
}

/**
 * Read and decode one bounded JSON request body.
 * @param req - incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the decoded JSON value.
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.resume()
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new Error(`the request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('the request body is not valid JSON'))
      }
    })
    req.on('error', (error) => { fail(error) })
  })
}

/**
 * Write one JSON response unless the client already went away.
 * @param res - response to own.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function send(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * Classify a thrown value into a stable machine code.
 * @param error - thrown value.
 * @returns the value's own code, or a generic failure code.
 */
function errorCodeOf(error) {
  const code = error?.code
  return typeof code === 'string' && code !== '' ? code : 'completion-failed'
}

/**
 * Read one thrown value as display text.
 * @param error - thrown value.
 * @returns the error message, or the stringified value.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unexpected failure'
}

/**
 * Accept one positive integer or fall back to the default.
 * @param value - candidate.
 * @param fallback - default used when the candidate is unusable.
 * @returns the accepted integer.
 */
function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Accept one finite number or fall back to the default.
 * @param value - candidate.
 * @param fallback - default used when the candidate is unusable.
 * @returns the accepted number.
 */
function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Accept one non-empty string or fall back to the default.
 * @param value - candidate.
 * @param fallback - default used when the candidate is unusable.
 * @returns the accepted string.
 */
function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}
