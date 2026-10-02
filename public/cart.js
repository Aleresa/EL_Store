import {catalogBrand} from './catalog-config.js';
export const cartKey=(shipmentId,id)=>`${shipmentId}:${id}`;
export const cartEntry=(shipmentId,p,quantity)=>({shipmentId,id:p.id,sku:p.sku,name:p.name,price:p.price,quantity});
export function readCart(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const cart={};
  for(const l of Object.values(value).slice(0,100)){
    if(!l||typeof l.shipmentId!=='string'||!/^[-\w]{1,80}$/.test(l.shipmentId)||typeof l.id!=='string'||!/^[-\w]{1,80}$/.test(l.id)||!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>10000000||!Number.isSafeInteger(l.price)||l.price<0||l.price>100000000)continue;
    cart[cartKey(l.shipmentId,l.id)]=cartEntry(l.shipmentId,{id:l.id,sku:String(l.sku||l.id).slice(0,80),name:String(l.name||l.id).slice(0,500),price:l.price},l.quantity);
  }
  return cart;
}
export function reconcileCart(cart,catalogs){
  const next={},changes=[];
  for(const line of Object.values(cart)){
    const catalog=catalogs.find(s=>s.id===line.shipmentId),p=catalog?.products.find(p=>p.id===line.id);
    const brand=catalogBrand(catalog),label=`${brand?.name||line.shipmentId} · ${line.sku}`;
    if(!brand||brand.hidden||catalog?.hidden||catalog?.status!=='arrived'||!p||p.hidden||p.stock<=0||!brand.categories.includes(p.group)){
      changes.push(`${label}: недоступен, убран из корзины.`);continue;
    }
    const quantity=Math.min(line.quantity,p.stock);
    if(quantity!==line.quantity)changes.push(`${label}: количество уменьшено с ${line.quantity} до ${quantity}.`);
    if(line.price!==p.price)changes.push(`${label}: цена изменилась с ${(line.price/100).toFixed(2)} до ${(p.price/100).toFixed(2)} ₽.`);
    next[cartKey(line.shipmentId,p.id)]=cartEntry(line.shipmentId,p,quantity);
  }
  return {cart:next,changes};
}
export function repeatCart(cart,order,catalogs){
  const result=reconcileCart(cart,catalogs),next=result.cart,changes=[...result.changes];
  for(const l of order.lines){
    const shipmentId=l.shipmentId??order.shipmentId,key=cartKey(shipmentId,l.id),old=next[key];
    if(!old&&Object.keys(next).length>=100){changes.push(`${l.sku}: не добавлен — в корзине уже 100 позиций.`);continue;}
    const desired=cartEntry(shipmentId,l,(old?.quantity||0)+l.quantity);
    const checked=reconcileCart({[key]:desired},catalogs);
    changes.push(...checked.changes);
    if(checked.cart[key])next[key]=checked.cart[key];
  }
  return {cart:next,changes};
}
