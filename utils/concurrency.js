function createConcurrencyLimit(concurrency) {
    let active = 0;
    const queue = [];

    const runNext = () => {
        while (active < concurrency && queue.length > 0) {
            active += 1;
            const { fn, resolve, reject } = queue.shift();

            Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .finally(() => {
                    active -= 1;
                    runNext();
                });
        }
    };

    return (fn) =>
        new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            runNext();
        });
}

/** Run tasks with a concurrency cap (separate queue per limiter instance). */
async function mapWithLimit(items, limit, mapper) {
    const runLimit = createConcurrencyLimit(limit);

    return Promise.all(
        items.map((item, index) =>
            runLimit(() => mapper(item, index)),
        ),
    );
}

module.exports = {
    createConcurrencyLimit,
    mapWithLimit,
};
