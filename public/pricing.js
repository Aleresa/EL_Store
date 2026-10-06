export const MIN_ORDER = 1000000; // kopecks
export const wholesaleTier = quantity => quantity >= 100 ? 2 : quantity >= 20 ? 1 : 0;
export const validPrices = prices => Array.isArray(prices) && prices.length === 3 && prices.every(p => Number.isSafeInteger(p) && p > 0 && p <= 100000000);
export const isRemaxGlass = (brand, product) => (brand?.id === 'remax' || String(brand?.name || '').trim().toLowerCase() === 'remax') && (/^(GL-27(?: Privacy)?|ES-01)$/i.test(product.group || '') || /стекл|glass/i.test(product.name || ''));
export const unitPrice = (product, quantity, eligible) => eligible && validPrices(product.prices) ? product.prices[wholesaleTier(quantity)] : product.price;
export function priceLines(lines) {
  const quantity = lines.reduce((n,l) => n + (l.wholesale ? l.quantity : 0), 0);
  return lines.map(l => ({...l, price:unitPrice(l, quantity, l.wholesale)}));
}
