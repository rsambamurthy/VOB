/** Status badge for a message sent to the ERP (purchase-order replies and sourcing awards share the outbound pipeline). */
const MSG_STATUS: Record<string, [string, string]> = { SENT: ['Sent', 'badge-approved'], TEST: ['Test mode — not sent', 'badge-in_progress'], PENDING: ['Sending…', 'badge-under_review'], FAILED: ['Failed', 'badge-rejected'], NO_CONNECTOR: ['No ERP connection', 'badge-invited'] };

export function MessageStatus({ status, error }: { status: string; error?: string | null }) {
  const [label, cls] = MSG_STATUS[status] ?? [status, ''];
  return <><span className={`badge ${cls}`}>{label}</span>{error && status === 'FAILED' && <div className="err-text small">{error}</div>}</>;
}
