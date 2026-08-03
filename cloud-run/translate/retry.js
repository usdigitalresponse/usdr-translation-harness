const DEFAULT_RETRIES = 1;
const DEFAULT_DELAY_MS = 3000;

async function withRetry(fn, { retries = DEFAULT_RETRIES, delayMs = DEFAULT_DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        console.warn(`Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

module.exports = { withRetry, DEFAULT_RETRIES, DEFAULT_DELAY_MS };
