import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigationPicture, sectionTabs, sectionPanel, resetSectionTabs } from './section-navigation.mjs';

test('all main sections have distinct offline picture icons without replacing their text labels', () => {
  const views = ['home', 'lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'billing', 'users', 'storage',
    'security', 'residents', 'meters', 'assets', 'incidents', 'contractors'];
  const pictures = views.map(navigationPicture);
  assert.equal(new Set(pictures).size, views.length);
  for (const picture of pictures) {
    assert(picture.includes('viewBox="0 0 24 24"'));
    assert(picture.includes('aria-hidden="true"'));
    assert(!picture.includes('http'));
  }
  assert.throws(() => navigationPicture('missing'), /Unknown navigation picture/);
});
test('tab lists and panels have linked accessible IDs, one initial selection and escaped labels', () => {
  resetSectionTabs();
  const tabs = sectionTabs('sample', 'Example <tabs>', [['details', 'Details & notes'], ['photos', 'Photos']], 'photos');
  assert.equal((tabs.match(/aria-selected="true"/g) || []).length, 1);
  assert(tabs.includes('aria-label="Example &lt;tabs&gt;"'));
  assert(tabs.includes('Details &amp; notes'));
  assert(tabs.includes('id="sample-tab-photos"'));
  assert(tabs.includes('aria-controls="sample-panel-photos"'));
  assert(sectionPanel('sample', 'details').includes('hidden'));
  assert(!sectionPanel('sample', 'photos').includes('hidden'));
  assert(sectionPanel('sample', 'photos').includes('aria-labelledby="sample-tab-photos"'));
});
