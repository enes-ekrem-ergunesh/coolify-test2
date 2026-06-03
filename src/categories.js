const INCOME_CATEGORIES = ['salary', 'freelance', 'bonus', 'gift', 'investment', 'loan'];
const EXPENSE_CATEGORIES = [
  'groceries',
  'dining',
  'transport',
  'utilities',
  'rent',
  'shopping',
  'health',
  'entertainment',
  'education',
  'travel',
  'loan',
  'gift',
  'family',
  'charity',
];

function categoryOptions(type) {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

module.exports = {
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  categoryOptions,
};
