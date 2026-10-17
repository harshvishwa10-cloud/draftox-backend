/**
 * Return status state machine. Customer submissions always START at SUBMITTED;
 * an admin drives APPROVE/REJECT/RECEIVED/RESOLVE. The refund subsystem owns
 * REFUND_INITIATED → REFUND_COMPLETED. RESOLVED/CLOSED/REJECTED are terminal.
 */
import type { ReturnStatus } from '@prisma/client';

export const RETURN_STATUSES: readonly ReturnStatus[] = [
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'ITEM_RECEIVED',
  'REFUND_INITIATED',
  'REFUND_COMPLETED',
  'RESOLVED',
  'CLOSED',
] as const;

/** Forward transitions. Terminal states map to an empty list. */
export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  SUBMITTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['ITEM_RECEIVED', 'REJECTED', 'RESOLVED'],
  ITEM_RECEIVED: ['RESOLVED'],
  REFUND_INITIATED: ['REFUND_COMPLETED', 'RESOLVED'],
  REFUND_COMPLETED: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  REJECTED: ['CLOSED'],
  CLOSED: [],
};

export function canTransitionReturn(from: ReturnStatus, to: ReturnStatus): boolean {
  return RETURN_TRANSITIONS[from].includes(to);
}

export function isTerminalReturnStatus(status: ReturnStatus): boolean {
  return status === 'RESOLVED' || status === 'CLOSED' || status === 'REJECTED';
}

/**
 * Maps an admin action to the target status it may be applied to.
 * Note: RESOLVED also advances the refund subsystem when the order is paid and
 * verified (handled by the controller), and REFUND_* transitions are reserved
 * for that subsystem, not admin actions.
 */
export type ReturnAdminAction = 'APPROVE' | 'REJECT' | 'RECEIVED' | 'RESOLVE';

export const RETURN_ACTION_TARGETS: Record<
  ReturnAdminAction,
  { from: readonly ReturnStatus[]; to: ReturnStatus }
> = {
  APPROVE: { from: ['SUBMITTED'], to: 'APPROVED' },
  REJECT: { from: ['SUBMITTED', 'APPROVED'], to: 'REJECTED' },
  RECEIVED: { from: ['APPROVED'], to: 'ITEM_RECEIVED' },
  RESOLVE: { from: ['ITEM_RECEIVED', 'APPROVED'], to: 'RESOLVED' },
};

export function actionTargetFor(action: ReturnAdminAction, from: ReturnStatus): ReturnStatus | null {
  const target = RETURN_ACTION_TARGETS[action];
  if (!target) return null;
  return (target.from as readonly ReturnStatus[]).includes(from) ? target.to : null;
}

export const RETURN_REASON_LABELS: Record<string, string> = {
  DEFECTIVE: 'Defective / not working',
  NOT_AS_DESCRIBED: 'Not as described',
  DAMAGED_IN_TRANSIT: 'Damaged in transit',
  WRONG_ITEM: 'Wrong item delivered',
  OTHER: 'Other',
};

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ITEM_RECEIVED: 'Item received',
  REFUND_INITIATED: 'Refund initiated',
  REFUND_COMPLETED: 'Refund completed',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};