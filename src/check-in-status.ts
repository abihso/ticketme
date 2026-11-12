export type CheckInAction = "CHECK_IN" | "CHECK_OUT";

export function canTransitionCheckIn(
  action: CheckInAction,
  checkedInAt: Date | null,
  checkedOutAt: Date | null,
): boolean {
  const currentlyInside = checkedInAt !== null && checkedOutAt === null;
  return action === "CHECK_IN" ? !currentlyInside : currentlyInside;
}
