const inflight = new Map();

async function dedupe(key, fn) {
    if (inflight.has(key)) {
        return inflight.get(key);
    }

    const promise = Promise.resolve()
        .then(fn)
        .finally(() => {
            inflight.delete(key);
        });

    inflight.set(key, promise);
    return promise;
}

function inflightCount() {
    return inflight.size;
}

module.exports = { dedupe, inflightCount };
