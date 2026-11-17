export function hasEventEnded(
  event: { startsAt: Date; endsAt: Date | null },
  now = Date.now(),
): boolean {
  return (event.endsAt ?? event.startsAt).getTime() <= now;
}
