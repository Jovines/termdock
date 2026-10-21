/** Manual pause stops new launches; in-flight launches must finish before dismissal. */
export function canDismissTmuxRecoveryOperation(operation: { state: string; paused: boolean; running: number }): boolean {
  return operation.state === 'succeeded' || operation.state === 'partial_failure'
    || (operation.state === 'paused' && operation.paused && operation.running === 0);
}
