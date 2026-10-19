/**
 * Grid Trading Simulator — DISPLAY-ONLY statutory/brokerage charges
 * estimate (ADR-035). Never affects cash/holdings/realizedPnL — the
 * FIFO/rebase accounting (ADR-031/ADR-032) is the confirmed benchmark and
 * is completely untouched by this file; this only aggregates an estimate
 * over the already-persisted trade ledger for display.
 *
 * Rates are Zerodha's published charges (zerodha.com/charges, read
 * 2026-10-19) for NSE equity delivery, futures, and options:
 *
 *   - Brokerage: ₹0 for equity delivery, flat ₹20/executed order for
 *     futures & options (the exact values given for this feature — the
 *     real "0.03% or ₹20, whichever is lower" rule for intraday/futures
 *     is NOT implemented; this is a deliberate simplification).
 *   - STT: 0.1% on both buy & sell for equity delivery; 0.05% on the sell
 *     side only for futures; 0.15% on the sell side (on premium) for
 *     options.
 *   - Exchange transaction charges (NSE): 0.00307% (equity), 0.00183%
 *     (futures), 0.03553% (options on premium) — both sides, all segments.
 *   - SEBI charges: ₹10/crore (0.0001%) — both sides, all segments.
 *   - Stamp duty: buy side only — 0.015% (equity), 0.002% (futures),
 *     0.003% (options on premium).
 *
 * Any segment other than these three (BSE F&O, MCX, etc.) falls back to
 * the FUTURES rate structure as the closest structural analogue — not
 * segment-exact (e.g. MCX has no STT but a different Commodity
 * Transaction Tax not modeled here). Flagged via `approximate: true` on
 * the summary so the UI can disclose it rather than imply precision it
 * doesn't have.
 */

const KNOWN_SEGMENTS = new Set(["EQUITY_DELIVERY", "FUTURES", "OPTIONS"]);

const RATES = {
    EQUITY_DELIVERY: {
        brokeragePerOrder: 0,
        sttBuyPct: 0.001,
        sttSellPct: 0.001,
        exchangeTxnPct: 0.0000307,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00015,
    },
    FUTURES: {
        brokeragePerOrder: 20,
        sttBuyPct: 0,
        sttSellPct: 0.0005,
        exchangeTxnPct: 0.0000183,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00002,
    },
    OPTIONS: {
        brokeragePerOrder: 20,
        sttBuyPct: 0,
        sttSellPct: 0.0015,
        exchangeTxnPct: 0.0003553,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00003,
    },
};

/** Classifies an Upstox instrument-master entry into the 3 modeled
 *  segments — same OPT/CE/PE/FUT/FO detection heuristic already used by
 *  marketDataService.js's getFeedModeForInstrumentKey, applied here for
 *  charges instead of WS feed mode. Falls back to "FUTURES" for any F&O-
 *  like segment this module doesn't model exactly (e.g. MCX), and to
 *  "EQUITY_DELIVERY" ("normal") otherwise — never throws. */
function classifySegmentClass(instrumentMeta) {
    const type = String(instrumentMeta?.instrumentType || instrumentMeta?.type || "").toUpperCase();
    const segment = String(instrumentMeta?.segment || "").toUpperCase();

    if (type.includes("OPT") || type === "CE" || type === "PE" || type === "CALL" || type === "PUT") {
        return "OPTIONS";
    }
    if (type.includes("FUT") || segment.includes("FO") || segment.includes("MCX")) {
        return "FUTURES";
    }
    return "EQUITY_DELIVERY";
}

/** Charges for one filled trade. `trade` needs `type` ("BUY"/"SELL"),
 *  `qtyFilled`, and `effectivePrice` (falls back to `fillPrice`). */
function chargesForTrade(trade, segmentClass) {
    const rates = RATES[segmentClass] || RATES.FUTURES;
    const unitPrice = trade.effectivePrice ?? trade.fillPrice;
    const turnover = Math.abs((unitPrice || 0) * (trade.qtyFilled || 0));

    if (!(turnover > 0)) {
        return { brokerage: 0, stt: 0, exchangeTxnCharges: 0, sebiFee: 0, stampDuty: 0, total: 0 };
    }

    const brokerage = rates.brokeragePerOrder;
    const stt = turnover * (trade.type === "BUY" ? rates.sttBuyPct : rates.sttSellPct);
    const exchangeTxnCharges = turnover * rates.exchangeTxnPct;
    const sebiFee = turnover * rates.sebiPct;
    const stampDuty = trade.type === "BUY" ? turnover * rates.stampDutyBuyPct : 0;
    const total = brokerage + stt + exchangeTxnCharges + sebiFee + stampDuty;

    return { brokerage, stt, exchangeTxnCharges, sebiFee, stampDuty, total };
}

/** Sums charges across every FILLED trade (qtyFilled > 0 — a fully
 *  skipped trade never actually executes, so it never incurs a real
 *  charge). Each field rounded to paise for display. */
function summarizeCharges(trades, segmentClass) {
    const totals = { brokerage: 0, stt: 0, exchangeTxnCharges: 0, sebiFee: 0, stampDuty: 0, total: 0 };

    trades.forEach((trade) => {
        if (!(trade.qtyFilled > 0)) return;
        const c = chargesForTrade(trade, segmentClass);
        totals.brokerage += c.brokerage;
        totals.stt += c.stt;
        totals.exchangeTxnCharges += c.exchangeTxnCharges;
        totals.sebiFee += c.sebiFee;
        totals.stampDuty += c.stampDuty;
        totals.total += c.total;
    });

    Object.keys(totals).forEach((key) => {
        totals[key] = Math.round(totals[key] * 100) / 100;
    });

    return { ...totals, segmentClass, approximate: !KNOWN_SEGMENTS.has(segmentClass) };
}

module.exports = { classifySegmentClass, chargesForTrade, summarizeCharges };
