const CURRENCY_SYMBOLS = {
  USD: "$",
  INR: "₹",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  AUD: "A$",
  CAD: "C$",
};

function inferCurrency(symbol = "", market = "", currency = "") {
  if (currency) return currency.toUpperCase();

  const upper = symbol.toUpperCase();

  if (
    market === "CRYPTO" ||
    market === "NASDAQ" ||
    market === "NYSE" ||
    upper.includes("-USD") ||
    upper.endsWith("-USD")
  ) {
    return "USD";
  }

  if (upper.endsWith(".NS") || upper.endsWith(".BO")) {
    return "INR";
  }

  return "INR";
}

function formatPrice(price, currency = "INR") {
  if (price === null || price === undefined || Number.isNaN(Number(price))) {
    return "--";
  }

  const code = inferCurrency("", "", currency);
  const symbol = CURRENCY_SYMBOLS[code] || `${code} `;

  return `${symbol}${Number(price).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPriceFromQuote(quote, stock = {}) {
  if (!quote?.price && quote?.price !== 0) return "--";

  const currency = inferCurrency(
    quote.symbol || stock.symbol,
    stock.market,
    quote.currency,
  );

  return formatPrice(quote.price, currency);
}

module.exports = {
  CURRENCY_SYMBOLS,
  inferCurrency,
  formatPrice,
  formatPriceFromQuote,
};
