// LLM client. Both backends speak the OpenAI chat-completions shape, so one
// code path covers OpenRouter (hosted) and LM Studio (the MacBook).

import { buildMessages } from './prompt.js';

function backendConfig(env) {
  const backend = env.LLM_BACKEND || 'openrouter';
  if (backend === 'lmstudio') {
    const base = env.LMSTUDIO_BASE_URL;
    if (!base) throw new Error('LLM_BACKEND=lmstudio but LMSTUDIO_BASE_URL is not set');
    return {
      backend,
      url: `${base.replace(/\/$/, '')}/chat/completions`,
      model: env.LMSTUDIO_MODEL || 'qwen/qwen3-coder-next',
      maxTokens: Number(env.LLM_MAX_TOKENS || 24000),
      headers: { 'Content-Type': 'application/json' },
    };
  }
  if (backend === 'openrouter') {
    const key = env.OPENROUTER_API_KEY;
    if (!key) throw new Error('LLM_BACKEND=openrouter but OPENROUTER_API_KEY is not set');
    const base = env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    return {
      backend,
      url: `${base.replace(/\/$/, '')}/chat/completions`,
      model: env.LLM_MODEL || 'moonshotai/kimi-k2.6',
      // A detailed build is 60-150 ops plus a plan block. At 8000 the JSON was
      // truncated mid-array and every build failed to parse.
      maxTokens: Number(env.LLM_MAX_TOKENS || 24000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        // OpenRouter uses these for its dashboard attribution.
        'HTTP-Referer': 'https://github.com/jhammant/MineCraftServer',
        'X-Title': 'Minecraft AI Builder',
      },
    };
  }
  throw new Error(`unknown LLM_BACKEND: ${backend}`);
}

// Models sometimes wrap JSON in prose or a markdown fence despite instructions.
// Recover the outermost JSON object rather than failing the child's build.
function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('model did not return JSON');
  }
}

async function callOnce(cfg, messages, { timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: cfg.headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.7,
        // A detailed build is 60-150 ops plus a plan block. At 8000 the JSON
        // was truncated mid-array and every build failed to parse.
        max_tokens: cfg.maxTokens,

        // Kimi is a reasoning model, and a build plan needs no deliberation -
        // the shape is fully specified by the prompt. Leaving reasoning on cost
        // ~2 minutes and a pile of tokens per build; off, it answers in seconds.
        ...(cfg.backend === 'openrouter' ? {
          reasoning: { enabled: false },
          // OpenRouter load-balances one model across providers that do NOT
          // behave identically: with response_format set, Together leaked the
          // reasoning trace into content and truncated on length, while
          // Parasail was fine. Rather than depend on which provider we land on,
          // we drop response_format and require providers to honour the
          // parameters we do send. extractJson() is the backstop.
          provider: { require_parameters: true },
        } : {
          response_format: { type: 'json_object' },
        }),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('LLM returned no content');
    // OpenRouter reports actual charged cost per call - use it rather than
    // guessing from token counts and a price list that will drift.
    return { plan: extractJson(text), usage: data.usage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the model for a build plan.
 *
 * `verify` is the caller's validator. When it throws, we hand the error text
 * back to the model and let it try again - a rejected plan is usually one bad
 * op, and the model fixes it readily when told exactly what failed.
 */
export async function generateBuildPlan(description, env, verify, { attempts = 3 } = {}) {
  const cfg = backendConfig(env);
  const messages = buildMessages(description);
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let plan;
    try {
      const result = await callOnce(cfg, messages);
      plan = result.plan;
      const verified = verify(plan);
      return { plan, verified, usage: result.usage, attempts: attempt, model: cfg.model };
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
      // Feed the failure back so the retry is informed rather than random.
      if (plan) {
        messages.push({ role: 'assistant', content: JSON.stringify(plan) });
        messages.push({
          role: 'user',
          content: `That plan was rejected: ${err.message}\n`
            + 'Fix exactly that problem and return the corrected JSON plan. JSON only.',
        });
      }
    }
  }
  throw lastErr;
}

export function describeBackend(env) {
  const cfg = backendConfig(env);
  return `${cfg.backend}:${cfg.model}`;
}
