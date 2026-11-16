/**
 * Network-condition simulation, so the dashboard's loading, error and retry states can be
 * exercised without touching the client.
 *
 * Per request:
 *   GET /employees?_delay=1500      answer after 1.5s (max 10s)
 *   GET /employees?_fail=500        answer 500 instead of the real response
 *   GET /employees?_fail=401        useful for the session-expiry path
 *
 * Globally (environment):
 *   SIM_DELAY=300        add 300ms to every response
 *   SIM_FAIL_RATE=0.1    fail 10% of requests at random with a 500
 *
 * `_delay` and `_fail` are stripped from the query before json-server sees them, so they never
 * become filters.
 */

const MAX_DELAY_MS = 10000;
const GLOBAL_DELAY = Number(process.env.SIM_DELAY || 0);
const GLOBAL_FAIL_RATE = Number(process.env.SIM_FAIL_RATE || 0);

const MESSAGES = {
  400: 'Simulated bad request',
  401: 'Simulated expired session',
  403: 'Simulated permission error',
  404: 'Simulated not found',
  409: 'Simulated conflict',
  422: 'Simulated validation error',
  500: 'Simulated server error',
  503: 'Simulated service unavailable',
};

function createSimulation() {
  return (req, res, next) => {
    const requestedDelay = Number(req.query._delay || 0);
    const requestedFail = Number(req.query._fail || 0);

    delete req.query._delay;
    delete req.query._fail;

    const delay = Math.min(MAX_DELAY_MS, Math.max(0, requestedDelay) + GLOBAL_DELAY);
    const randomFail = GLOBAL_FAIL_RATE > 0 && Math.random() < GLOBAL_FAIL_RATE;
    const status = requestedFail >= 400 && requestedFail <= 599 ? requestedFail : randomFail ? 500 : 0;

    const run = () => {
      if (status) {
        return res.status(status).jsonp({
          message: MESSAGES[status] || 'Simulated error',
          simulated: true,
          status,
        });
      }
      return next();
    };

    if (delay > 0) return setTimeout(run, delay);
    return run();
  };
}

module.exports = { createSimulation };
