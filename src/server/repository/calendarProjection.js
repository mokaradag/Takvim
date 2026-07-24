export function applyDefaultCalendarProjection(snapshot = {}, defaultCalendarId = null) {
  const normalizedDefaultId = defaultCalendarId == null ? null : String(defaultCalendarId);
  const calendars = (snapshot.calendars || []).map((calendar) => ({
    ...calendar,
    isDefault: normalizedDefaultId != null && String(calendar.id) === normalizedDefaultId
  }));

  calendars.sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
  return { ...snapshot, calendars };
}
