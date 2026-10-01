// Only administrator-created groups. Product names never determine grouping.
export const groupKey=value=>String(value??'').trim().toLowerCase().replaceAll('ё','е').replace(/\s+/g,' ');
export function manualProducts(products,groups=[],previous=[]){
  const names=new Map(groups.map(name=>[groupKey(name),name]));
  const saved=new Map(previous.map(p=>[p.id,p.group]));
  return products.map(({subgroup,groupingNote,groupingNeedsReview,...p})=>({...p,group:names.get(groupKey(saved.has(p.id)?saved.get(p.id):p.group))||''}));
}
export function groupProducts(products,groups=[]){
  if(!products.length)return [];
  const buckets=new Map(groups.map(name=>[groupKey(name),{name,products:[]}])),other=[];
  for(const p of products){const bucket=buckets.get(groupKey(p.group));if(bucket)bucket.products.push(p);else other.push(p);}
  const used=[...buckets.values()].filter(g=>g.products.length);
  if(!used.length)return [{name:'',products}];
  if(other.length)used.push({name:'',products:other});
  return used;
}
