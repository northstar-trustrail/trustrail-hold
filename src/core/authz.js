// Principals and least-privilege permissions. Each role can do only its own step.
export const ROLES = {
  buyer_agent: ['hold.propose', 'hold.read.own'],
  buyer: ['hold.approve_policy', 'hold.authorize', 'hold.read.own', 'hold.refund'],
  seller: ['hold.deliver', 'hold.read.assigned'],
  reviewer: ['hold.resolve', 'hold.read.all'],
  auditor: ['hold.read.all', 'ledger.read'],
  system: ['hold.sweep', 'hold.read.all', 'ledger.read'],
};
export class Forbidden extends Error { constructor(m) { super(m); this.status = 403; } }
export function can(actor, perm) { return !!actor && (ROLES[actor.role] || []).includes(perm); }
export function assertCan(actor, perm, hold) {
  if (!can(actor, perm)) throw new Forbidden(`${actor?.role || 'anonymous'} may not ${perm}`);
  if (!hold) return;
  if (actor.role === 'seller' && hold.sellerId !== actor.id) throw new Forbidden(`seller ${actor.id} is not assigned to ${hold.id}`);
  if ((actor.role === 'buyer' || actor.role === 'buyer_agent') && hold.buyerId !== actor.org) throw new Forbidden(`${actor.id} is not the buyer of ${hold.id}`);
}
export function canRead(actor, hold) {
  if (can(actor, 'hold.read.all')) return true;
  if (actor?.role === 'seller') return hold.sellerId === actor.id;
  return can(actor, 'hold.read.own') && hold.buyerId === actor.org;
}
