// Turns a Google API error into a plain explanation of why a resource couldn't
// be opened. Google often reports "not shared with you" as 404 (not found) so
// as not to reveal that the file exists, so 404 can mean either.

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/**
 * @param {Error} err - googleapis error (has .code, or .response.status)
 * @param {string} kind - What was being opened, e.g. "doc", "sheet", "folder"
 * @param {string} id - Its ID, quoted in the message
 * @returns {string}
 */
function describeAccessError(err, kind, id) {
  const status = err.code || (err.response && err.response.status);
  if (status === HTTP_FORBIDDEN) {
    return `The service account doesn't have access to ${kind} ${id} (it exists, but isn't shared with the service account).`;
  }
  if (status === HTTP_NOT_FOUND) {
    return `${capitalize(kind)} ${id} wasn't found: the ID is wrong, it was deleted, or it isn't shared with the service account.`;
  }
  if (status === HTTP_BAD_REQUEST && /parse range/i.test(err.message)) {
    return `The tab doesn't exist in ${kind} ${id} (renamed or deleted?).`;
  }
  return `Can't open ${kind} ${id}: ${err.message}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { describeAccessError };
