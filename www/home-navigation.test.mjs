import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { canUseSection, isManagementRole } from './account-access.mjs';
import { navigationPicture } from './section-navigation.mjs';

const source = await fs.readFile(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderHome()');
const end = source.indexOf('\nfunction renderCheckProjects()', start);
const sections = [
  ['home', 'Home'], ['lighting', 'Lighting surveys'], ['checks', 'Building checks'],
  ['tickets', 'Maintenance tickets'], ['log-ticket', 'Log a ticket'], ['appliances', 'Appliance reports'],
  ['billing', 'Accounts & billing'], ['security', 'Security'], ['residents', 'Students / tenants'],
  ['meters', 'Meter checks'], ['assets', 'Asset management'], ['incidents', 'Incident reporting'],
  ['contractors', 'Contractor management'], ['users', 'Users'], ['storage', 'Report storage']
];
const allowed = {
  office_admin: ['billing'],
  admin: ['lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'billing', 'security', 'residents', 'meters', 'assets', 'incidents', 'contractors', 'users', 'storage'],
  maintenance_manager: ['lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'billing', 'security', 'residents', 'meters', 'assets', 'incidents', 'contractors', 'users'],
  portfolio_manager: ['lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'billing', 'security', 'residents', 'meters', 'assets', 'incidents', 'contractors', 'users'],
  building_manager: ['lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'billing', 'security', 'residents', 'meters', 'assets', 'incidents', 'contractors', 'users'],
  operations_manager: ['lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'security', 'residents', 'meters', 'assets', 'incidents', 'contractors', 'users'],
  maintenance_assistant: ['lighting', 'checks', 'tickets', 'meters', 'assets', 'incidents'],
  user: ['tickets', 'log-ticket', 'billing', 'security', 'residents', 'incidents'],
  technician: ['appliances']
};

for (const [role, views] of Object.entries(allowed)) {
  test(`home shows all permitted navigation cards for ${role}, without unrelated sections`, () => {
    const buttons = sections.map(([view, textContent]) => ({
      dataset: { view }, textContent, hidden: view !== 'home' && !views.includes(view)
    }));
    const ops = (isManagementRole(role) || role === 'maintenance_assistant')
      && (canUseSection({ role }, 'lighting') || canUseSection({ role }, 'checks'));
    const context = vm.createContext({
      hasOpsAccess: () => ops, stateLoadError: null, currentUser: { role }, canUseSection, navigationPicture,
      state: { surveys: [], buildingChecks: [] },
      workspace: { innerHTML: '', querySelector: () => null }, refreshPlatformLedger: async () => {},
      document: { querySelectorAll: () => buttons },
      escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
    });
    vm.runInContext(source.slice(start, end), context);
    context.renderHome();
    const html = context.workspace.innerHTML;
    assert.deepEqual([...html.matchAll(/data-home-view="([^"]+)"/g)].map((match) => match[1]), views);
    assert(html.includes('aria-label="All workspace sections"'));
    assert(html.includes('data-subscribe>Subscribe</button>'));
    assert(html.includes('use Home to return here'));
    assert.equal(html.includes('aria-label="Building check conditions"'), ops);
    assert.equal(html.includes('Start a light survey'), ops);
    assert(!html.includes('data-home-view="home"'));
    assert.equal((html.match(/class="navigation-picture"/g) || []).length, views.length);
    if (views.includes('billing')) assert(html.includes('Accounts &amp; billing'));
  });
}
