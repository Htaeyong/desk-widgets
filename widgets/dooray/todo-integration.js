/** Converts a Dooray deadline into Todo's epoch-millisecond deadline without moving a date-only day. */
function todoDeadline(task) {
  const raw = String(task?.dueDate || '');
  const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(raw);
  // Dooray encodes a date-only deadline as a local-midnight ISO instant.
  const dateOnly = plainDate || (Number.isFinite(parsed.getTime()) && parsed.getHours() === 0
    && parsed.getMinutes() === 0 && parsed.getSeconds() === 0 && parsed.getMilliseconds() === 0);
  const day = plainDate ? new Date(`${raw}T00:00:00`) : parsed;
  const at = dateOnly ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59).getTime()
    : Date.parse(task?.deadline || raw);
  return Number.isSafeInteger(at) && at > 0 ? { dueAt: at, dateOnly } : { dueAt: null, dateOnly: false };
}

module.exports = { todoDeadline };
