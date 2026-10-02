export const BRANDS = [
  {id:'apple',name:'Apple',categories:['Оригинал','Копия']},
  {id:'remax',name:'Remax',categories:['GL-27','GL-27 Privacy','ES-01']}
];

export const brandById = id => BRANDS.find(brand => brand.id === id);

export function searchCatalog(catalogs, query) {
  const normalize = value => String(value ?? '').trim().toLowerCase().replaceAll('ё','е');
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return BRANDS.flatMap(brand => {
    const catalog = catalogs.find(item => item.id === brand.id);
    if (!catalog || catalog.status !== 'arrived') return [];
    return catalog.products.filter(product => !product.hidden && product.stock > 0 && brand.categories.includes(product.group))
      .filter(product => {
        const text = normalize(`${brand.name} ${product.group} ${product.name} ${product.sku} ${product.id}`);
        return terms.every(term => text.includes(term));
      }).map(product => ({brand, product}));
  });
}
