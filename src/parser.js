const OpenAI = require('openai');
const { INCOME_CATEGORIES, EXPENSE_CATEGORIES } = require('./categories');

const KEYWORDS = {
  income: {
    salary: ['salary', 'paycheck', 'wage'],
    freelance: ['freelance', 'client', 'contract'],
    bonus: ['bonus', 'commission'],
    gift: ['gift', 'present', 'allowance'],
    investment: ['dividend', 'investment', 'interest', 'stock'],
  },
  expense: {
    groceries: ['market', 'grocery', 'groceries', 'supermarket'],
    dining: ['restaurant', 'coffee', 'cafe', 'lunch', 'dinner', 'breakfast'],
    transport: ['uber', 'taxi', 'metro', 'bus', 'train', 'fuel', 'gas'],
    utilities: ['internet', 'electric', 'electricity', 'water', 'phone', 'utility', 'bill'],
    rent: ['rent'],
    shopping: ['shirt', 't-shirt', 'tshirt', 'clothes', 'shopping', 'shoes'],
    health: ['pharmacy', 'doctor', 'medicine', 'hospital', 'health'],
    entertainment: ['movie', 'netflix', 'game', 'concert', 'cinema'],
    education: ['course', 'book', 'tuition', 'school', 'class'],
    travel: ['flight', 'hotel', 'trip', 'vacation', 'travel'],
  },
};

const CURRENCY_KEYWORDS = {
  USD: /\b(?:usd|us\$|dollar(?:s)?|bucks?)\b/i,
  EUR: /\b(?:eur|euro(?:s)?)\b/i,
  GBP: /\b(?:gbp|pound(?:s)?)\b/i,
  TRY: /\b(?:try|tl|lira)\b/i,
};

function normalizeWhitespace(value) {
  return value.replace(/'/g, '').replace(/\s+/g, ' ').trim();
}

function detectCurrency(message) {
  for (const [currency, pattern] of Object.entries(CURRENCY_KEYWORDS)) {
    if (pattern.test(message)) {
      return currency;
    }
  }
  return 'USD';
}

function detectAmount(message) {
  const match = message.match(/(\d+(?:[.,]\d+)?)\s*(k)?/i);
  if (!match) {
    return null;
  }

  const numeric = Number.parseFloat(match[1].replace(',', '.'));
  if (Number.isNaN(numeric)) {
    return null;
  }

  return match[2] ? numeric * 1000 : numeric;
}

function detectCategory(message, type) {
  const catalogue = KEYWORDS[type];
  if (!catalogue) {
    return null;
  }

  for (const [category, keywords] of Object.entries(catalogue)) {
    if (keywords.some((keyword) => message.includes(keyword))) {
      return category;
    }
  }
  return null;
}

function detectType(message) {
  const lowered = message.toLowerCase();
  const incomeCategory = detectCategory(lowered, 'income');
  const expenseCategory = detectCategory(lowered, 'expense');

  if (incomeCategory && !expenseCategory) {
    return 'income';
  }

  if (expenseCategory && !incomeCategory) {
    return 'expense';
  }

  if (/\b(?:got|received|earned)\b/.test(lowered)) {
    return 'income';
  }

  if (/\b(?:paid|spent|bought)\b/.test(lowered)) {
    return 'expense';
  }

  return null;
}

function heuristicParse(message) {
  const normalized = normalizeWhitespace(message.toLowerCase());
  const type = detectType(normalized);
  const amount = detectAmount(normalized);
  const currency = amount ? detectCurrency(normalized) : null;
  const category = type ? detectCategory(normalized, type) : null;

  if (!type || !amount || !category) {
    return {
      status: 'manual',
      parserSource: 'heuristic',
      reason: 'Could not confidently infer all entry fields.',
      message: message.trim(),
      type,
      amount,
      currency,
      category,
      description: message.trim(),
    };
  }

  return {
    status: 'complete',
    parserSource: 'heuristic',
    reason: null,
    message: message.trim(),
    type,
    amount,
    currency,
    category,
    description: message.trim(),
  };
}

function normalizeAiResult(message, payload) {
  const normalizedType = payload.type === 'income' || payload.type === 'expense' ? payload.type : null;
  const categoryPool = normalizedType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const normalizedCategory = categoryPool.includes(payload.category) ? payload.category : null;
  const amount = typeof payload.amount === 'number' ? payload.amount : Number(payload.amount);
  const currency = typeof payload.currency === 'string' && payload.currency.trim() ? payload.currency.toUpperCase() : 'USD';
  const understood = Boolean(payload.understood && normalizedType && normalizedCategory && Number.isFinite(amount) && amount > 0);

  if (!understood) {
    return {
      status: 'manual',
      parserSource: 'openai',
      reason: payload.reason || 'The AI parser could not confidently structure this message.',
      message: message.trim(),
      type: normalizedType,
      amount: Number.isFinite(amount) ? amount : null,
      currency,
      category: normalizedCategory,
      description: payload.description || message.trim(),
    };
  }

  return {
    status: 'complete',
    parserSource: 'openai',
    reason: null,
    message: message.trim(),
    type: normalizedType,
    amount,
    currency,
    category: normalizedCategory,
    description: payload.description || message.trim(),
  };
}

async function openAiParse(message, config) {
  if (!config.apiKey) {
    return null;
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });

  const completion = await client.chat.completions.create({
    model: config.model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You convert personal finance messages into structured budget entries.',
          'Use only these income categories: salary, freelance, bonus, gift, investment.',
          'Use only these expense categories: groceries, dining, transport, utilities, rent, shopping, health, entertainment, education, travel.',
          'Return JSON with keys understood (boolean), type, category, amount, currency, description, and reason.',
          'If you are not confident, set understood to false and explain why in reason.',
          'Normalize currency to ISO code like USD.',
        ].join(' '),
      },
      {
        role: 'user',
        content: message,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    return {
      status: 'manual',
      parserSource: 'openai',
      reason: 'The AI parser returned an empty response.',
      message: message.trim(),
      type: null,
      amount: null,
      currency: null,
      category: null,
      description: message.trim(),
    };
  }

  return normalizeAiResult(message, JSON.parse(content));
}

async function parseMessage(message, config = {}) {
  const trimmed = normalizeWhitespace(message);
  if (!trimmed) {
    return {
      status: 'manual',
      parserSource: 'manual',
      reason: 'Empty message.',
      message: '',
      type: null,
      amount: null,
      currency: null,
      category: null,
      description: '',
    };
  }

  try {
    const aiResult = await openAiParse(trimmed, config);
    if (aiResult) {
      return aiResult;
    }
  } catch (error) {
    const fallback = heuristicParse(trimmed);
    if (fallback.status === 'complete') {
      return {
        ...fallback,
        parserSource: 'openai-fallback',
      };
    }

    return {
      ...fallback,
      reason: `OpenAI parsing failed; saved for review. ${error.message}`,
      parserSource: 'openai-fallback',
    };
  }

  return heuristicParse(trimmed);
}

module.exports = {
  detectAmount,
  heuristicParse,
  parseMessage,
};
