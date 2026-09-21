import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const ui = await readFile('module/game-ui.js', 'utf8');
const css = await readFile('module/relationship-feedback.css', 'utf8');
const index = await readFile('index.html', 'utf8');

assert.match(ui, /relationship-value-number/);
assert.doesNotMatch(ui.slice(ui.indexOf('function updateRelationshipsDisplay'), ui.indexOf('function showTooltip')), /gift-btn|giveGift/);
assert.match(ui, /showRelationshipTooltip\(card, text\)/);
assert.match(ui, /document\.getElementById\('main-viewport'\)/);
assert.match(ui, /position:fixed/);
assert.match(css, /white-space:\s*nowrap/);
assert.match(css, /font-size: 14px !important/);
assert.match(css, /@media \(max-width: 600px\) \{[^}]+\}[^}]+font-size: 11px !important/);
assert.match(css, /white-space:\s*pre-wrap/);
assert.match(css, /overflow-y:\s*auto/);
assert.match(ui, /max-height:\$\{bottom - top\}px/);
assert.match(index, /module\/relationship-feedback\.css/);

console.log('relationship-feedback.unit: ok');
