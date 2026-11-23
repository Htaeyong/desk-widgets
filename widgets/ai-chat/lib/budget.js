// The monthly budget (#129, design 10). An API key cannot read a balance, so this is the user's budget minus what this widget
// estimated, always shown as an estimate. Kept in a file on this PC, never synced.
const fs = require('fs');
const path = require('path');

// USD per million tokens, from the pricing page on 2026-11-07. Only for a run that ended with no reported cost.
const PRICES = {
  'claude-opus-5-5': { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5, longPromptTokens: 100000, longPromptFactor: 5 },
};

/** Cost of one model message's usage, or null when the model's price is not known. */
function costOfUsage(model, usage) {
  const price = PRICES[model];
  if (!price) return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(usage?.input_tokens);
  const read = n(usage?.cache_read_input_tokens);
  const written = n(usage?.cache_creation_input_tokens);
  const output = n(usage?.output_tokens);
  const written1h = Math.min(written, n(usage?.cache_creation?.ephemeral_1h_input_tokens));
  const factor = price.longPromptTokens && input + read + written > price.longPromptTokens ? price.longPromptFactor : 1;
  return factor * (input * price.input + (written - written1h) * price.write5m + written1h * price.write1h + read * price.read + output * price.output) / 1e6;
}

/** A session's total_cost_usd counts everything before it too (S7): this is what the new report adds. */
function deltaOfReport(last, reported) {
  const before = Number.isFinite(last) ? last : 0;
  return reported >= before ? reported - before : reported;
}

const pad = (n) => String(n).padStart(2, '0');

/** The local date the budget period containing `at` began, as YYYY-MM-DD. */
function periodStart(at, resetDay) {
  const d = new Date(at);
  let year = d.getFullYear();
  let month = d.getMonth();
  if (d.getDate() < resetDay) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return `${year}-${pad(month + 1)}-${pad(resetDay)}`;
}

function createBudget({ file, settings, now = Date.now }) {
  function load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch { /* first use, or a broken file: start the period over */ }
    const period = periodStart(now(), settings().resetDay);
    if (raw.period !== period) return { period, spentUsd: 0, partial: false, warned: false, seen: false };
    return { period, spentUsd: Number(raw.spentUsd) > 0 ? Number(raw.spentUsd) : 0, partial: raw.partial === true, warned: raw.warned === true, seen: raw.seen === true };
  }

  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  function view() {
    const s = load();
    const budgetUsd = settings().monthlyBudgetUsd;
    const share = s.spentUsd / budgetUsd;
    return {
      budgetUsd, taskCapUsd: settings().taskCapUsd, spentUsd: s.spentUsd, remainingUsd: Math.max(0, budgetUsd - s.spentUsd), hasData: s.seen, partial: s.partial, period: s.period,
      level: share >= 1 ? 'over' : (share >= 0.8 ? 'warn' : 'ok'),
    };
  }

  return {
    view,
    /** Adds to this period; `partial` when a run's cost could not be known. Returns true the one time 80% is crossed. */
    add(usd, { partial = false } = {}) {
      const s = load();
      s.spentUsd += Number.isFinite(usd) && usd > 0 ? usd : 0;
      s.partial = s.partial || partial;
      s.seen = true;
      const crossed = !s.warned && s.spentUsd / settings().monthlyBudgetUsd >= 0.8;
      if (crossed) s.warned = true;
      write(s);
      return crossed;
    },
  };
}

module.exports = { createBudget, costOfUsage, deltaOfReport, periodStart, PRICES };
