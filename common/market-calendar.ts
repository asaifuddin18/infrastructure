/**
 * NYSE/NASDAQ full-day closures. EventBridge Scheduler cannot express market
 * holidays, so the snapshot job checks this list before doing any work.
 */
const MARKET_HOLIDAYS: readonly string[] = [
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed, Jul 4 falls on Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving Day
  '2026-12-25', // Christmas Day

  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Washington's Birthday
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed, Jun 19 falls on Saturday)
  '2027-07-05', // Independence Day (observed, Jul 4 falls on Sunday)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving Day
  '2027-12-24', // Christmas Day (observed, Dec 25 falls on Saturday)
];

const HOLIDAY_SET = new Set(MARKET_HOLIDAYS);

/** Latest date covered by the hardcoded holiday table. */
export const CALENDAR_COVERAGE_END = '2027-12-31';

/**
 * Returns true when US equity markets hold a regular session on the given date.
 * Dates are ISO `YYYY-MM-DD` strings already resolved to America/New_York.
 */
export function isTradingDay(isoDate: string): boolean {
  if (HOLIDAY_SET.has(isoDate)) {
    return false;
  }
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * Returns true when the holiday table no longer covers the given date. The snapshot
 * job logs a warning in this case so the list gets extended before it silently
 * starts treating holidays as trading days.
 */
export function isBeyondCalendarCoverage(isoDate: string): boolean {
  return isoDate > CALENDAR_COVERAGE_END;
}

/**
 * Returns the most recent trading day strictly before the given date, used to locate
 * the prior snapshot when computing daily movement.
 */
export function previousTradingDay(isoDate: string): string {
  const cursor = new Date(`${isoDate}T12:00:00Z`);
  do {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  } while (!isTradingDay(cursor.toISOString().slice(0, 10)));
  return cursor.toISOString().slice(0, 10);
}
