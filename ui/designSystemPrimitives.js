const PANEL_SELECTORS = [
  '.hh-person-card',
  '.hh-summary-shell',
  '.nw-rail',
  '.gh-card',
  '.gh-rail',
  '.gh-add-panel',
  '.compare',
  '.cf-panel',
  '.focus__panel',
  '.solve-panel',
  '.taw-card--inputs',
  '.taw-card',
  '.seq-chart',
  '.seq-print',
];

const RAISED_PANEL_SELECTORS = [
  '.nw-tile',
  '.gh-band',
  '.gh-starter',
  '.rail-card',
];

const FIELD_SELECTORS = [
  'label.hh-field',
  '.sf-field',
  '.gh-field',
  '.taw-field',
];

const SEGMENTED_SELECTORS = [
  '.seg',
  '.gh-seg',
  '.gh-mini-seg',
  '.hh-seg',
  '.taw-seg',
];

const CHIP_SELECTORS = [
  '.goal-pill',
  '.tag-ref',
  '.tag-delta',
  '.cell__delta',
  '.badge-editing',
  '.goal-state',
  '.gh-chip',
  '.seq-chip',
  '.cf-scenario-picker',
  '.cf-ret-toggle',
  '.cf__path-controls',
];

const STEPPER_BUTTON_SELECTORS = [
  '.cmp-step-btn',
  '.stepper-btn',
  '.gh-money-row > button',
  '.gh-once-age button',
  '.gh-category',
];

const ICON_BUTTON_SELECTORS = [
  '.hh-menu__btn',
  '.gh-rail__close',
  '.scol__menu',
];

const PRIMARY_BUTTON_SELECTORS = [
  '.hh-footer-next',
  '.nw-primary-button',
  '.gh-done',
  '.sf-go',
];

const GHOST_BUTTON_SELECTORS = [
  '.hh-footer-back',
  '.nw-secondary-button',
  '.gh-ghost',
  '.gh-add-row',
  '.hh-add-row',
  '.solve-clear',
];

const DESTRUCTIVE_BUTTON_SELECTORS = [
  '.hh-card-action',
  '.gh-delete',
];

function addClasses(element, classes) {
  classes.forEach((className) => element.classList.add(className));
}

function forEachMatch(root, selectors, callback) {
  const selector = selectors.join(',');
  if (root.nodeType === 1 && root.matches(selector)) callback(root);
  root.querySelectorAll?.(selector).forEach(callback);
}

function decorateInputs(root) {
  forEachMatch(root, ['select'], (element) => element.classList.add('px-select'));
  forEachMatch(root, ['textarea'], (element) => element.classList.add('px-input'));
  forEachMatch(root, ['input'], (element) => {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) return;
    element.classList.add('px-input');
    if (element.matches('.cmp-lev-in,.cmp-goal-in')) {
      element.classList.add('px-input--inline');
    } else if (type === 'number' || ['numeric', 'decimal'].includes(element.inputMode)) {
      element.classList.add('px-input--numeric');
    }
  });
}

function decorateButtons(root) {
  forEachMatch(root, ['button'], (button) => {
    if (button.matches('.htab,.hh-step')) {
      button.classList.add('px-nav');
      return;
    }
    if (button.matches('.cash-chip')) {
      addClasses(button, ['px-chip', 'px-chip--pill']);
      return;
    }
    if (button.closest('.px-seg')) return;
    if (button.matches(STEPPER_BUTTON_SELECTORS.join(','))) {
      button.classList.add('px-stepper-btn');
      return;
    }

    button.classList.add('px-btn');
    if (button.matches(PRIMARY_BUTTON_SELECTORS.join(','))) button.classList.add('px-btn--primary');
    if (button.matches(GHOST_BUTTON_SELECTORS.join(','))) button.classList.add('px-btn--ghost');
    if (button.matches(DESTRUCTIVE_BUTTON_SELECTORS.join(','))) button.classList.add('px-btn--destructive');
    if (button.matches(ICON_BUTTON_SELECTORS.join(','))) addClasses(button, ['px-btn--icon', 'px-btn--compact']);
  });
}

function syncStates(root) {
  forEachMatch(root, ['.htab,.hh-step'], (element) => {
    element.classList.toggle('is-active', element.classList.contains('on') || element.classList.contains('is-current'));
  });
  forEachMatch(root, ['.cash-chip'], (element) => {
    element.classList.toggle('is-selected', element.classList.contains('is-on'));
  });
  forEachMatch(root, ['.seg > button,.gh-seg > button,.gh-mini-seg > button,.hh-seg > button,.taw-seg > button'], (element) => {
    const selected = element.classList.contains('is-active')
      || element.classList.contains('is-selected')
      || element.getAttribute('aria-selected') === 'true'
      || element.getAttribute('aria-pressed') === 'true';
    element.classList.toggle('is-selected', selected);
  });
}

export function decorateDesignSystemPrimitives(root = document) {
  forEachMatch(root, PANEL_SELECTORS, (element) => element.classList.add('px-panel'));
  forEachMatch(root, RAISED_PANEL_SELECTORS, (element) => addClasses(element, ['px-panel', 'px-panel--raised']));
  forEachMatch(root, FIELD_SELECTORS, (element) => element.classList.add('px-field'));
  forEachMatch(root, SEGMENTED_SELECTORS, (element) => element.classList.add('px-seg'));
  forEachMatch(root, CHIP_SELECTORS, (element) => element.classList.add('px-chip'));
  decorateInputs(root);
  decorateButtons(root);
  syncStates(root);
}

export function installDesignSystemPrimitives(root = document) {
  decorateDesignSystemPrimitives(root);
  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === 'attributes') {
        syncStates(record.target);
        return;
      }
      record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) decorateDesignSystemPrimitives(node);
      });
    });
  });
  observer.observe(root.documentElement || root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-checked', 'aria-pressed', 'aria-selected', 'class'],
  });
  return () => observer.disconnect();
}
