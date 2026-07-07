/** Serializes Upstox REST calls to avoid burst 429s. */
const { recordUpstoxApiCall } = require("./metrics");

let chain = Promise.resolve();
let lastRequestAt = 0;

const MIN_GAP_MS = Number(process.env.UPSTOX_REQUEST_GAP_MS || 50);

function enqueue(task) {
    const run = chain.then(async () => {
        const elapsed = Date.now() - lastRequestAt;
        const wait = Math.max(0, MIN_GAP_MS - elapsed);
        if (wait > 0) {
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
        lastRequestAt = Date.now();
        recordUpstoxApiCall();
        return task();
    });

    chain = run.catch(() => {});
    return run;
}

module.exports = { enqueue };
