/**
 * Workstream K — pure notification text builder, kept separate from any
 * DB/orchestration code so the signal-vs-fill wording distinction (the
 * milestone's #2 requirement) is directly unit-testable against fixtures.
 *
 * Hard rule: a *_FILLED notification describes a SIMULATED position
 * change only. The wording always says "simulated" explicitly — this
 * system has no real broker integration anywhere (Workstream J's
 * LiveStrategyRuntime never places a real order), and a notification
 * must never imply otherwise.
 */

const EXIT_REASON_LABEL = {
    SIGNAL: "a strategy exit signal",
    STOP_LOSS: "a stop-loss",
    TAKE_PROFIT: "a take-profit target",
    TRAILING_STOP: "a trailing stop",
    END_OF_DATA: "end of available data",
};

function formatPrice(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "—";
}

/**
 * `signal`: a LiveStrategySignal document (or plain object with the same
 *   fields) — `type`, `price`, `quantity`, `exitReason`, `netPnl`,
 *   `returnPct`, `barDate`.
 * `runtime`: `{ symbol, timeframe }` — just enough context to make the
 *   message self-contained without a second DB round trip per field.
 * `strategyName`: display name, optional (falls back to "Your strategy").
 */
function buildNotificationContent({ signal, runtime, strategyName }) {
    const name = strategyName || "Your strategy";
    const symbol = runtime?.symbol || "the instrument";
    const timeframe = runtime?.timeframe || "";

    switch (signal.type) {
        case "ENTRY_SIGNAL":
            return {
                isFill: false,
                title: `Entry signal — ${symbol}`,
                body: `${name} generated a BUY entry signal on ${symbol} (${timeframe}). This is a signal only — no simulated position has been opened yet.`,
            };
        case "EXIT_SIGNAL":
            return {
                isFill: false,
                title: `Exit signal — ${symbol}`,
                body: `${name} generated an exit signal on ${symbol} (${timeframe}). This is a signal only — the simulated position is still open until it fills.`,
            };
        case "ENTRY_FILLED":
            return {
                isFill: true,
                title: `Simulated position opened — ${symbol}`,
                body: `${name}'s SIMULATED position opened on ${symbol} at ${formatPrice(signal.price)} (qty ${signal.quantity ?? "—"}). No real order was placed.`,
            };
        case "EXIT_FILLED": {
            const reason = EXIT_REASON_LABEL[signal.exitReason] || "the strategy's exit rule";
            const pnl = Number.isFinite(signal.netPnl) ? signal.netPnl : null;
            const pnlLabel = pnl === null ? "" : ` Net P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${formatPrice(signal.returnPct)}%).`;
            return {
                isFill: true,
                title: `Simulated position closed — ${symbol}`,
                body: `${name}'s SIMULATED position on ${symbol} closed at ${formatPrice(signal.price)} due to ${reason}.${pnlLabel} No real order was placed.`,
            };
        }
        default:
            return {
                isFill: false,
                title: `Update — ${symbol}`,
                body: `${name} produced a new event on ${symbol}.`,
            };
    }
}

module.exports = { buildNotificationContent };
