// Only models explicitly present in a product name are offered; compatibility is never guessed.
export function phoneModels(name){
  const text=String(name).replace(/ё/gi,'е'),models=new Set();
  const start=/(?:iphone|айфон|\bip)\s*[-:]?\s*/gi;
  const model=/^(SE(?:\s*20(?:16|20|22))?|X(?:S(?:\s*Max)?|R)?|Air|(?:[6-9]|1\d)(?:\s*(?:Pro\s*Max|Pro|Plus|Mini|Air|[es]))?)(?![\w])/i;
  for(const match of text.matchAll(start)){
    let rest=text.slice(match.index+match[0].length);
    while(true){
      const found=rest.match(model);if(!found)break;
      const normalized=found[1].replace(/\s+/g,' ').trim().replace(/pro\s*max/i,'Pro Max').replace(/pro/i,'Pro').replace(/plus/i,'Plus').replace(/mini/i,'Mini').replace(/air/i,'Air').replace(/max/i,'Max').replace(/^se/i,'SE').replace(/^x[rs]?/i,m=>m.toUpperCase()).replace(/(\d)\s*([es])$/i,(_,n,s)=>n+s.toLowerCase());
      models.add('iPhone '+normalized);
      rest=rest.slice(found[0].length);
      const separator=rest.match(/^\s*(?:\/|,|;|\+|и)\s*(?:(?:iphone|айфон|ip)\s*)?/i);
      if(!separator)break;rest=rest.slice(separator[0].length);
    }
  }
  return [...models];
}
const nameCompare=(a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true});
export function sortProducts(products,sort='new'){
  return [...products].sort((a,b)=>{
    if(sort==='price-asc')return a.price-b.price||nameCompare(a,b);
    if(sort==='price-desc')return b.price-a.price||nameCompare(a,b);
    if(sort==='name')return nameCompare(a,b);
    return (Date.parse(b.addedAt)||0)-(Date.parse(a.addedAt)||0)||(a.position??0)-(b.position??0)||nameCompare(a,b);
  });
}
