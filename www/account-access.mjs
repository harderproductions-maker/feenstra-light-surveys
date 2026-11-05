import managerRoles from './manager-roles.json' with { type: 'json' };

export { managerRoles };
export const isManagerRole = (role) => managerRoles.includes(role);
export const isManagementRole = (role) => role === 'admin' || isManagerRole(role);
export const managerProfiles = [
  ['office_admin', 'Office Administrator'],
  ['portfolio_manager', 'Portfolio Manager'], ['building_manager', 'Building Manager'],
  ['operations_manager', 'Operations Manager'], ['maintenance_manager', 'Maintenance Manager']
];
export const accountSections = [
  ['tickets', 'Maintenance tickets'], ['appliances', 'Appliance reports'],
  ['billing', 'Billing'], ['users', 'User management'],
  ['lighting', 'Lighting surveys'], ['checks', 'Building checks'],
  ['security', 'Security'], ['residents', 'Students / tenants & visitors'],
  ['meters', 'Meter checks'], ['assets', 'Asset management'],
  ['incidents', 'Incident reporting'], ['contractors', 'Contractor management'],
  ['leasing', 'Leasing & tenant management (test mode)']
];
const defaults = {
  admin: accountSections.map(([id]) => id),
  office_admin: ['leasing', 'billing'],
  maintenance_manager: accountSections.filter(([id]) => id !== 'leasing').map(([id]) => id),
  portfolio_manager: accountSections.map(([id]) => id),
  building_manager: accountSections.map(([id]) => id),
  operations_manager: accountSections.filter(([id]) => !['billing', 'leasing'].includes(id)).map(([id]) => id),
  maintenance_assistant: ['tickets', 'lighting', 'checks', 'meters', 'assets', 'incidents'],
  technician: ['appliances'],
  user: ['tickets', 'billing', 'security', 'residents', 'incidents', 'leasing']
};
export function sectionsFor(user) {
  if (!user || user.billingBlocked) return [];
  const sections = isManagerRole(user.role) && Array.isArray(user.sections)
    ? user.sections : defaults[user.role] || [];
  return Array.isArray(user.companyFeatures)
    ? sections.filter((section) => section === 'users' || user.companyFeatures.includes(section)) : sections;
}
export function canUseSection(user, section) {
  return sectionsFor(user).includes(section);
}
export function canDelegateAccounts(user) {
  return user?.role === 'admin'
    || (isManagerRole(user?.role) && user.adminRights === true && canUseSection(user, 'users'));
}
export function accountBuildingIds(role, propertyIds) {
  if (!Array.isArray(propertyIds) || !propertyIds.length
      || propertyIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('Choose at least one assigned building under Buildings & access.');
  }
  const ids = [...new Set(propertyIds)];
  if (role === 'user' && ids.length !== 1) throw new Error('Students and tenants must be assigned to exactly one building.');
  return ids;
}
export function sectionForPath(path) {
  if (/^\/api\/leasing(?:\/|\?|$)/.test(path)) return 'leasing';
  const operation = /^\/api\/operations\/([^/?]+)(?:\/|\?|$)/.exec(path);
  if (operation) return operation[1];
  if (/^\/api\/check-templates(\/|$)/.test(path)) return 'checks';
  if (/^\/api\/(tickets|ticket-assignees)(\/|\?|$)/.test(path)) return 'tickets';
  if (/^\/api\/(appliance-|technician-|building-quote-contacts)/.test(path)) return 'appliances';
  if (/^\/api\/billing\//.test(path)) return 'billing';
  if (/^\/api\/users(\/|$)/.test(path) || path === '/api/properties:create') return 'users';
  return null;
}
export function canManageAccountPermissions(user, account) {
  if (user?.role === 'admin') return true;
  if (!canUseSection(user, 'users') || account.id === user?.id || account.role === 'admin') return false;
  if (isManagerRole(account.role) && (!canDelegateAccounts(user) || account.adminRights || account.admin_rights)) return false;
  return sectionsFor({ ...account, companyFeatures: isManagerRole(account.role) ? undefined : user.companyFeatures })
    .every((section) => canUseSection(user, section));
}
