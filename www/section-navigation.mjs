const pictures = {
  home: '<path d="m3 11 9-8 9 8v10H3Z"/><path d="M9 21v-8h6v8"/>',
  lighting: '<path d="M8 16c0-3-3-4-3-8a7 7 0 0 1 14 0c0 4-3 5-3 8Z"/><path d="M8 19h8m-6 3h4M9 8l3 5 3-5"/>',
  checks: '<rect x="4" y="4" width="16" height="18" rx="2"/><path d="M9 4V2h6v2M8 10l2 2 5-5m-7 9h8m-8 3h5"/>',
  tickets: '<path d="M14 3a6 6 0 0 0-7 7L2 15a4 4 0 0 0 6 6l5-5a6 6 0 0 0 7-7l-4 4-5-5Z"/><circle cx="5" cy="18" r="1"/>',
  'log-ticket': '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 7h8m-8 4h4m0 3v6m-3-3h6"/>',
  appliances: '<rect x="3" y="2" width="18" height="20" rx="2"/><circle cx="12" cy="14" r="6"/><path d="M7 14c3-3 7 3 10 0M6 5h4m6 0h2"/>',
  billing: '<path d="M5 2h14v20l-3-2-4 2-4-2-3 2Z"/><path d="M9 6h6m-6 4h6m-6 4h6m-3-9v10"/>',
  leasing: '<path d="M3 22V3h12v19m0-14h6v14M7 7h4m-4 4h4m-4 4h4M7 22v-3h4v3"/>',
  users: '<circle cx="9" cy="7" r="4"/><path d="M2 22v-3a7 7 0 0 1 14 0v3M17 3a4 4 0 0 1 0 8m2 3a7 7 0 0 1 3 6v2"/>',
  storage: '<path d="M2 6V3h8l3 3h9v16H2Z"/><path d="M2 10h20m-14 5h8"/>',
  security: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  residents: '<path d="M3 22V3h12v19m0-14h6v14M7 7h4m-4 4h4m-4 4h4m-4 7v-3h4v3"/>',
  meters: '<circle cx="12" cy="12" r="9"/><path d="m12 12 5-5M6 17h12m-6-4v1"/>',
  assets: '<path d="m3 7 9-5 9 5v10l-9 5-9-5Zm0 0 9 5 9-5m-9 5v10M7 4l10 6"/>',
  incidents: '<path d="m12 2 10 19H2Z"/><path d="M12 8v6m0 3v1"/>',
  contractors: '<path d="M3 8h18v13H3Zm5 0V3h8v5M3 13h18m-11 0v3h4v-3"/>'
};

const escape = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const selectedTabs = new Map();

export function navigationPicture(view) {
  if (!pictures[view]) throw new Error(`Unknown navigation picture: ${view}`);
  return `<svg class="navigation-picture" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${pictures[view]}</svg>`;
}

export function sectionTabs(id, label, tabs, initial = tabs[0][0]) {
  if (!tabs.some(([key]) => key === selectedTabs.get(id))) selectedTabs.set(id, initial);
  return `<div class="section-tabs" role="tablist" aria-label="${escape(label)}">${tabs.map(([key, title]) =>
    `<button class="button secondary" type="button" role="tab" id="${escape(id)}-tab-${escape(key)}"
      aria-controls="${escape(id)}-panel-${escape(key)}" aria-selected="${selectedTabs.get(id) === key}"
      tabindex="${selectedTabs.get(id) === key ? 0 : -1}" data-section-tab="${escape(key)}">${escape(title)}</button>`).join('')}</div>`;
}

export function sectionPanel(id, key) {
  return `id="${escape(id)}-panel-${escape(key)}" role="tabpanel" aria-labelledby="${escape(id)}-tab-${escape(key)}"
    data-section-panel="${escape(key)}" tabindex="0" ${selectedTabs.get(id) === key ? '' : 'hidden'}`;
}

export function resetSectionTabs(root) {
  const groups = root ? [...(root.matches?.('[data-section-group]') ? [root] : []),
    ...root.querySelectorAll('[data-section-group]')] : [];
  for (const group of groups) {
    const first = [...group.querySelectorAll('[data-section-tab]')]
      .find((button) => button.closest('[data-section-group]') === group);
    if (first) selectTab(group, first.dataset.sectionTab);
  }
  selectedTabs.clear();
}

function selectTab(group, key, focus = false) {
  const owned = (selector) => [...group.querySelectorAll(selector)]
    .filter((element) => element.closest('[data-section-group]') === group);
  const buttons = owned('[data-section-tab]');
  if (!buttons.some((button) => button.dataset.sectionTab === key)) return;
  selectedTabs.set(group.dataset.sectionGroup, key);
  for (const button of buttons) {
    const active = button.dataset.sectionTab === key;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  }
  for (const panel of owned('[data-section-panel]')) panel.hidden = panel.dataset.sectionPanel !== key;
}

export function wireSectionTabs(root) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-section-tab]');
    if (button) selectTab(button.closest('[data-section-group]'), button.dataset.sectionTab);
  });
  root.addEventListener('keydown', (event) => {
    const button = event.target.closest('[data-section-tab]');
    if (!button) return;
    const group = button.closest('[data-section-group]');
    const buttons = [...group.querySelectorAll('[data-section-tab]')]
      .filter((item) => item.closest('[data-section-group]') === group);
    let index = buttons.indexOf(button);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') index = (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buttons.length - 1;
    else return;
    event.preventDefault();
    selectTab(group, buttons[index].dataset.sectionTab, true);
  });
  root.addEventListener('invalid', (event) => {
    for (let element = event.target.parentElement; element; element = element.parentElement) {
      if (element.matches('details')) element.open = true;
      if (element.matches('[data-section-panel]')) {
        selectTab(element.closest('[data-section-group]'), element.dataset.sectionPanel);
      }
    }
  }, true);
}
