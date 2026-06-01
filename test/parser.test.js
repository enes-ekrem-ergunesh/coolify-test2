const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicParse } = require('../src/parser');

test('parses salary income messages with shorthand amounts', () => {
  const result = heuristicParse('got salary 2k dollars');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'income');
  assert.equal(result.category, 'salary');
  assert.equal(result.amount, 2000);
  assert.equal(result.currency, 'USD');
});

test('parses grocery expenses', () => {
  const result = heuristicParse('market 5 USD');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'expense');
  assert.equal(result.category, 'groceries');
  assert.equal(result.amount, 5);
  assert.equal(result.currency, 'USD');
});

test('marks unclear messages for manual review', () => {
  const result = heuristicParse('sorted some money stuff out');
  assert.equal(result.status, 'manual');
  assert.equal(result.amount, null);
});
