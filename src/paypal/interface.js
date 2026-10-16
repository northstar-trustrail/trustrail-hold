/**
 * PayPalClient: the only surface the escrow engine uses. Both adapters return
 * the same shapes as PayPal REST (Orders v2 + Payments v2).
 *   createAuthorizeOrder({ holdId, amount, currency, description, merchantId, returnUrl, cancelUrl }) -> { id, status, approveUrl }
 *   getOrder(orderId) -> order JSON
 *   authorizeOrder(orderId) -> { orderId, authorizationId, status, expiresAt }
 *   captureAuthorization(authorizationId, { amount, currency, invoiceId, note }) -> { captureId, status }
 *   voidAuthorization(authorizationId) -> { status: 'VOIDED' }
 *   refundCapture(captureId, { note }) -> { refundId, status }
 */
export function parseAuthorizeResponse(order) {
  const auth = order?.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error('PayPal authorize response had no authorization');
  return { orderId: order.id, authorizationId: auth.id, status: auth.status, expiresAt: auth.expiration_time };
}
export function approveLink(order) {
  return (order.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve')?.href;
}
