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

test('parses loan as income when money is received', () => {
  const result = heuristicParse('received loan 500 USD');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'income');
  assert.equal(result.category, 'loan');
  assert.equal(result.amount, 500);
  assert.equal(result.currency, 'USD');
});

test('parses gift as expense when money is spent', () => {
  const result = heuristicParse('bought gift 75 USD');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'expense');
  assert.equal(result.category, 'gift');
  assert.equal(result.amount, 75);
  assert.equal(result.currency, 'USD');
});

test('parses loan repayment as expense', () => {
  const result = heuristicParse('paid loan repayment 120 USD');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'expense');
  assert.equal(result.category, 'loan');
  assert.equal(result.amount, 120);
  assert.equal(result.currency, 'USD');
});

test('parses family spending as expense', () => {
  const result = heuristicParse('paid family support 200 USD');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'expense');
  assert.equal(result.category, 'family');
  assert.equal(result.amount, 200);
  assert.equal(result.currency, 'USD');
});

test('parses charity spending as expense', () => {
  const result = heuristicParse('donation for charity 30 USD');
  assert.equal(result.status, 'complete');
  assert.equal(result.type, 'expense');
  assert.equal(result.category, 'charity');
  assert.equal(result.amount, 30);
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
