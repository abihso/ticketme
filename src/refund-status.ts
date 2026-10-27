export function canReviewRefundStatus(status: string): boolean {
  return status === "PENDING";
}
