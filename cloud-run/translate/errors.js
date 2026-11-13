// Error classes for Translate's failures, so each kind can be told apart by
// class (for the plain-language reason in Chat) rather than by message text.

/** A Model Config sheet problem (missing columns, no rows, sheet ID unset). */
class ModelConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelConfigError";
  }
}

/** A required environment variable isn't set on the service. */
class MissingSettingError extends Error {
  constructor(envVar) {
    super(`${envVar} not set in .env`);
    this.name = "MissingSettingError";
  }
}

/** The model's output wasn't valid JSON. */
class InvalidOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidOutputError";
  }
}

/** The model's output was valid JSON but skipped blocks. */
class IncompleteTranslationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IncompleteTranslationError";
  }
}

/**
 * A failure after model work was already done and billed: saving a successful
 * call's output (savingFailed), or one chunk failing after others finished
 * (cause is the chunk's error). Never retried, since a retry would redo (and
 * re-bill) that work.
 */
class AlreadyBilledError extends Error {
  constructor(message, { cause, savingFailed = false } = {}) {
    super(message, { cause });
    this.name = "AlreadyBilledError";
    this.savingFailed = savingFailed;
  }
}

module.exports = {
  ModelConfigError, MissingSettingError, InvalidOutputError, IncompleteTranslationError, AlreadyBilledError,
};
