/**
 * job_queue.js — run async jobs with a concurrency limit and a bounded waiting line
 *
 * Compiling is CPU heavy and the toolchain shares one cache directory, so builds run one at a
 * time. If too many requests are already waiting, new ones are refused immediately instead of
 * piling up without limit.
 */

export class QueueFullError extends Error {
    constructor() {
        super('The compile service is busy; try again in a moment');
        this.name = 'QueueFullError';
    }
}

export function createJobQueue({ concurrency = 1, maxWaiting = 4 } = {}) {
    let running = 0;
    const waiting = [];

    function next() {
        if (running >= concurrency || waiting.length === 0) return;
        const { job, resolve, reject } = waiting.shift();
        running++;
        Promise.resolve()
            .then(job)
            .then(resolve, reject)
            .finally(() => { running--; next(); });
    }

    return {
        run(job) {
            return new Promise((resolve, reject) => {
                if (running >= concurrency && waiting.length >= maxWaiting) {
                    reject(new QueueFullError());
                    return;
                }
                waiting.push({ job, resolve, reject });
                next();
            });
        },
        stats: () => ({ running, waiting: waiting.length })
    };
}
