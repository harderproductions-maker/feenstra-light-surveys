import { sectionsFor, canManageAccountPermissions, isManagerRole } from './account-access.mjs';

export function permissionKey(user) {
  return JSON.stringify([user?.role, [...new Set(user?.propertyIds || [])].sort(),
    [...sectionsFor(user)].sort(), user?.adminRights === true, user?.billingBlocked === true]);
}

export function canAccessBuilding(user, propertyId) {
  return user?.role === 'admin' || (user?.propertyIds || []).includes(propertyId);
}

export function canManageBuildingAccount(user, account) {
  if (user?.role === 'admin') return true;
  return isManagerRole(user?.role) && canManageAccountPermissions(user, account)
    && account.property_ids?.length > 0
    && account.property_ids.every((id) => canAccessBuilding(user, id));
}

export function canAccessBillingAccount(user, account) {
  return user?.role === 'admin' || (isManagerRole(user?.role)
    && account.property_ids?.length > 0
    && account.property_ids.every((id) => canAccessBuilding(user, id)));
}
