const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicParse, parseMessage } = require('../src/parser');

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

test('prefers the last numeric amount in item-count messages', () => {
  const result = heuristicParse('bought 2 shirts for 50 dollars');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'expense');
  assert.equal(result.category, 'shopping');
  assert.equal(result.amount, 50);
});

test('parseMessage returns a manual entry for empty input', async () => {
  const result = await parseMessage('   ');
  assert.equal(result.status, 'manual');
  assert.equal(result.reason, 'Empty message.');
});
