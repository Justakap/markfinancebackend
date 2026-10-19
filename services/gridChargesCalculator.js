/**
 * Grid Trading Simulator — DISPLAY-ONLY statutory/brokerage charges
 * estimate (ADR-035, rates corrected/expanded in ADR-036). Never affects
 * cash/holdings/realizedPnL — the FIFO/rebase accounting (ADR-031/
 * ADR-032) is the confirmed benchmark and is completely untouched by this
 * file; this only aggregates an estimate over the already-persisted trade
 * ledger for display.
 *
 * Rates are Zerodha's published charges (zerodha.com/charges, as of
 * October 2026 — actual rates vary by broker/exchange/contract):
 *
 *   Segment            Brokerage              STT/CTT                 Exchange fee        Stamp duty       SEBI fee
 *   Equity delivery    ₹0                     0.1% buy+sell           0.00307% (NSE)      0.015% buy       ₹10/crore
 *   Equity intraday    min(0.03%, ₹20/order)  0.025% sell             0.00307% (NSE)      0.003% buy       ₹10/crore
 *   Equity futures     min(0.03%, ₹20/order)  0.05% sell              0.00183% (NSE)      0.002% buy       ₹10/crore
 *   Equity options     ₹20/order              0.15% sell (premium)    0.03553% (premium)  0.003% buy       ₹10/crore
 *   Commodity futures  min(0.03%, ₹20/order)  CTT 0.01% sell          0.0021% (MCX)       0.002% buy       ₹10/crore
 *   Commodity options  ₹20/order              CTT 0.05% sell          0.0418% (MCX)       0.003% buy       ₹10/crore
 *
 *   GST: 18% of (brokerage + exchange fee + SEBI fee), every segment.
 *
 * Turnover for every rate above is `executed qty × executed price`
 * (`effectivePrice`, falling back to `fillPrice`) — for options/commodity
 * options this IS the premium turnover, since that's the actual traded
 * value. STT/CTT and stamp duty apply only to the side(s) named in the
 * table (buy, sell, or both); exchange fee and SEBI fee apply to both
 * sides, every segment.
 *
 * Not modeled (explicitly out of scope — the simulator has no concept of
 * expiry/exercise): the special 0.15% STT on the INTRINSIC VALUE of an
 * option bought and exercised (as opposed to sold) — every option trade
 * here is treated as a plain sell-side-STT scenario, matching how the
 * grid strategy actually trades (closing positions via an opposite trade,
 * never exercising).
 *
 * `EQUITY_INTRADAY` is modeled here for completeness/accuracy but is
 * never auto-selected by `classifySegmentClass` below — the grid
 * simulator holds positions indefinitely rather than auto-squaring-off
 * same-day, which is structurally an equity-delivery-style strategy, so
 * plain equity instruments classify as `EQUITY_DELIVERY`. Exchange fee is
 * NSE-specific; BSE's own (slightly different) equity exchange fee is not
 * separately modeled — equity instruments on any exchange use the NSE
 * rate above as a disclosed approximation.
 */

const KNOWN_SEGMENTS = new Set(["EQUITY_DELIVERY", "EQUITY_INTRADAY", "FUTURES", "OPTIONS", "COMMODITY_FUTURES", "COMMODITY_OPTIONS"]);

const RATES = {
    EQUITY_DELIVERY: {
        brokerage: { type: "flat", amount: 0 },
        sttBuyPct: 0.001,
        sttSellPct: 0.001,
        exchangeTxnPct: 0.0000307,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00015,
    },
    EQUITY_INTRADAY: {
        brokerage: { type: "minOfPctOrFlat", pct: 0.0003, flatCap: 20 },
        sttBuyPct: 0,
        sttSellPct: 0.00025,
        exchangeTxnPct: 0.0000307,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00003,
    },
    FUTURES: {
        brokerage: { type: "minOfPctOrFlat", pct: 0.0003, flatCap: 20 },
        sttBuyPct: 0,
        sttSellPct: 0.0005,
        exchangeTxnPct: 0.0000183,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00002,
    },
    OPTIONS: {
        brokerage: { type: "flat", amount: 20 },
        sttBuyPct: 0,
        sttSellPct: 0.0015,
        exchangeTxnPct: 0.0003553,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00003,
    },
    COMMODITY_FUTURES: {
        brokerage: { type: "minOfPctOrFlat", pct: 0.0003, flatCap: 20 },
        sttBuyPct: 0,
        sttSellPct: 0.0001, // CTT, non-agri
        exchangeTxnPct: 0.000021,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00002,
    },
    COMMODITY_OPTIONS: {
        brokerage: { type: "flat", amount: 20 },
        sttBuyPct: 0,
        sttSellPct: 0.0005, // CTT
        exchangeTxnPct: 0.000418,
        sebiPct: 0.000001,
        stampDutyBuyPct: 0.00003,
    },
};

const GST_RATE = 0.18;

function computeBrokerage(brokerageConfig, turnover) {
    if (brokerageConfig.type === "flat") return brokerageConfig.amount;
    if (brokerageConfig.type === "minOfPctOrFlat") return Math.min(turnover * brokerageConfig.pct, brokerageConfig.flatCap);
    return 0;
}

/** Classifies an Upstox instrument-master entry into one of the 6 modeled
 *  segments — same OPT/CE/PE/FUT/FO detection heuristic already used by
 *  marketDataService.js's getFeedModeForInstrumentKey, applied here for
 *  charges instead of WS feed mode. Commodity derivatives are checked
 *  FIRST and split into COMMODITY_FUTURES/COMMODITY_OPTIONS (never fall
 *  back to the equity F&O rates) — this includes both MCX itself and
 *  NSE's own commodity segment (`NSE_COM`, e.g. NSE-listed crude oil
 *  futures), confirmed via a live instrument-master lookup to be a
 *  genuinely distinct segment string from MCX, not a typo. Plain equity
 *  defaults to EQUITY_DELIVERY — see the file doc comment for why
 *  EQUITY_INTRADAY is never auto-selected. Never throws. */
function classifySegmentClass(instrumentMeta) {
    const type = String(instrumentMeta?.instrumentType || instrumentMeta?.type || "").toUpperCase();
    const segment = String(instrumentMeta?.segment || "").toUpperCase();
    const isOption = type.includes("OPT") || type === "CE" || type === "PE" || type === "CALL" || type === "PUT";
    const isFuture = type.includes("FUT") || segment.includes("FO");
    const isCommoditySegment = segment.includes("MCX") || segment.includes("NSE_COM");

    if (isCommoditySegment) {
        return isOption ? "COMMODITY_OPTIONS" : "COMMODITY_FUTURES";
    }
    if (isOption) return "OPTIONS";
    if (isFuture) return "FUTURES";
    return "EQUITY_DELIVERY";
}

/** Charges for one filled trade. `trade` needs `type` ("BUY"/"SELL"),
 *  `qtyFilled`, and `effectivePrice` (falls back to `fillPrice`). */
function chargesForTrade(trade, segmentClass) {
    const rates = RATES[segmentClass] || RATES.EQUITY_DELIVERY;
    const unitPrice = trade.effectivePrice ?? trade.fillPrice;
    const turnover = Math.abs((unitPrice || 0) * (trade.qtyFilled || 0));

    if (!(turnover > 0)) {
        return { brokerage: 0, stt: 0, exchangeTxnCharges: 0, sebiFee: 0, stampDuty: 0, gst: 0, total: 0 };
    }

    const brokerage = computeBrokerage(rates.brokerage, turnover);
    const stt = turnover * (trade.type === "BUY" ? rates.sttBuyPct : rates.sttSellPct);
    const exchangeTxnCharges = turnover * rates.exchangeTxnPct;
    const sebiFee = turnover * rates.sebiPct;
    const stampDuty = trade.type === "BUY" ? turnover * rates.stampDutyBuyPct : 0;
    const gst = GST_RATE * (brokerage + exchangeTxnCharges + sebiFee);
    const total = brokerage + stt + exchangeTxnCharges + sebiFee + stampDuty + gst;

    return { brokerage, stt, exchangeTxnCharges, sebiFee, stampDuty, gst, total };
}

/** Sums charges across every FILLED trade (qtyFilled > 0 — a fully
 *  skipped trade never actually executes, so it never incurs a real
 *  charge). Each field rounded to paise for display. */
function summarizeCharges(trades, segmentClass) {
    const totals = { brokerage: 0, stt: 0, exchangeTxnCharges: 0, sebiFee: 0, stampDuty: 0, gst: 0, total: 0 };

    trades.forEach((trade) => {
        if (!(trade.qtyFilled > 0)) return;
        const c = chargesForTrade(trade, segmentClass);
        totals.brokerage += c.brokerage;
        totals.stt += c.stt;
        totals.exchangeTxnCharges += c.exchangeTxnCharges;
        totals.sebiFee += c.sebiFee;
        totals.stampDuty += c.stampDuty;
        totals.gst += c.gst;
        totals.total += c.total;
    });

    Object.keys(totals).forEach((key) => {
        totals[key] = Math.round(totals[key] * 100) / 100;
    });

    return { ...totals, segmentClass, approximate: !KNOWN_SEGMENTS.has(segmentClass) };
}

module.exports = { classifySegmentClass, chargesForTrade, summarizeCharges };
