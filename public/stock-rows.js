// Stock-only import: never infer an SKU or a stock value from other columns.
const normalize=value=>String(value??'').trim().toLowerCase().replace(/ё/g,'е').replace(/[.\s_-]+/g,'');
const skuHeaders=['код','кодтовара','артикул'];
const stockHeaders=['доступно','остаток','колво','количество','фактическийостаток'];
const nameHeaders=['наименование','наименованиетовара','название','названиетовара'];
export function parseStockRows(rows){
  let header;
  for(const [rowNumber,row] of rows){
    const values=Object.entries(row).map(([column,value])=>[column,normalize(value)]);
    const find=aliases=>aliases.map(name=>values.find(([,value])=>value===name)?.[0]).find(column=>column!==undefined);
    const sku=find(skuHeaders),stock=find(stockHeaders),name=find(nameHeaders);
    if(sku!==undefined && stock!==undefined){header={rowNumber,sku,stock,name};break;}
  }
  if(!header)throw Error('В Excel нужны столбцы «Код» (или «Артикул») и «Доступно» (или «Остаток»).');
  const items=[],warnings=[],seen=new Map();
  let skipped=0;
  for(const [rowNumber,row] of rows){
    if(rowNumber<=header.rowNumber)continue;
    const sku=String(row[header.sku]??'').trim();
    if(!sku)continue;
    const raw=String(row[header.stock]??'').trim();
    // Group/subtotal rows in wholesale stock reports have no product name.
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(sku) &&
      ((header.name!==undefined&&!String(row[header.name]??'').trim()) || /^(итого|всего)\b/i.test(sku)))continue;
    // Keep article numbers exactly as displayed, including leading zeroes.
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(sku)){
      skipped++;if(warnings.length<30)warnings.push(`Строка ${rowNumber}: некорректный артикул «${sku.slice(0,40)}».`);
      continue;
    }
    const number=Number(raw.replace(/[\s\u00a0\u202f]/g,'').replace(',','.'));
    if(!raw || !Number.isSafeInteger(number) || number<0 || number>10000000){
      skipped++;if(warnings.length<30)warnings.push(`Строка ${rowNumber} (${sku}): нужен целый остаток от 0 до 10 000 000.`);
      continue;
    }
    if(seen.has(sku)){
      if(seen.get(sku)!==number)throw Error(`Артикул ${sku} встречается с разными остатками. Проверьте файл.`);
      continue;
    }
    seen.set(sku,number);
    if(items.length>=30000)throw Error('В файле больше 30 000 артикулов. Разделите выгрузку.');
    items.push({sku,stock:number});
  }
  if(!items.length)throw Error('В Excel не найдено корректных артикулов и остатков.');
  return {items,warnings,skipped,headerRow:header.rowNumber};
}
