import {MIN_ORDER,validPrices,isRemaxGlass,priceLines} from '../public/pricing.js';
import {ApiError} from './auth.mjs';
import {groupKey} from '../public/product-groups.js';
import {DEFAULT_BRANDS} from '../public/catalog-config.js';

const ACTIVE = new Set(['arrived']);
const STATUSES = new Set(['draft','arrived','closed']);
const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
const lineKey = l => `${l.shipmentId}:${l.id}`;
const trim = (s,n) => typeof s === 'string' ? s.trim().slice(0,n) : '';

export class Inventory {
  constructor(sql, transaction) {
    this.sql = sql;
    this.transaction = transaction;
    sql.exec(`CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS products (shipment TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, total INTEGER NOT NULL CHECK(total>=0), placed INTEGER NOT NULL DEFAULT 0 CHECK(placed>=0 AND placed<=total), PRIMARY KEY(shipment,id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, shipment TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(user_id,request_key))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, data TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('CREATE TABLE IF NOT EXISTS order_edits (user_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(user_id,request_key))');
    sql.exec('CREATE INDEX IF NOT EXISTS orders_user_status ON orders(user_id,status)');
    sql.exec('CREATE INDEX IF NOT EXISTS orders_shipment_status ON orders(shipment,status)');
    sql.exec('CREATE TABLE IF NOT EXISTS brands (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    for(const brand of DEFAULT_BRANDS){
      const saved=this.one('SELECT data FROM shipments WHERE id=?',brand.id),catalog=saved&&JSON.parse(saved.data);
      const data={...brand,categories:catalog?.groups?.length?catalog.groups:brand.categories,cover:null,hidden:false,revision:1};
      sql.exec('INSERT OR IGNORE INTO brands(id,data) VALUES(?,?)',brand.id,JSON.stringify(data));
    }
    // Manager assignment was removed from EL Store. Delete its old table and strip legacy order snapshots.
    sql.exec('DROP TABLE IF EXISTS managers');
    for(const row of [...sql.exec('SELECT id,data FROM orders')]) {
      const data=JSON.parse(row.data);
      if(Object.prototype.hasOwnProperty.call(data,'manager')) {
        delete data.manager;
        sql.exec('UPDATE orders SET data=? WHERE id=?',JSON.stringify(data),row.id);
      }
    }
  }
  rows(query,...bindings) { return [...this.sql.exec(query,...bindings)]; }
  one(query,...bindings) { return this.rows(query,...bindings)[0]; }
  brand(id) {const row=this.one('SELECT data FROM brands WHERE id=?',id);return row?JSON.parse(row.data):null;}
  brands(admin=false) {return this.rows('SELECT data FROM brands ORDER BY rowid').map(r=>JSON.parse(r.data)).filter(b=>admin||!b.hidden);}
  saveBrand(input,id=null) {
    if(id!==null&&!validId(id))throw new ApiError(400,'Некорректный бренд.');
    const name=trim(input.name,80),categories=input.categories;
    if(!name||typeof input.name!=='string'||input.name.trim().length>80)throw new ApiError(400,'Укажите название бренда до 80 символов.');
    if(!Array.isArray(categories)||!categories.length||categories.length>100||categories.some(c=>typeof c!=='string'||!c.trim()||c.length>80)||new Set(categories.map(groupKey)).size!==categories.length)throw new ApiError(400,'Укажите от 1 до 100 уникальных категорий, по одной на строку.');
    const names=categories.map(c=>c.trim().replace(/\s+/g,' '));
    if(typeof input.hidden!=='boolean')throw new ApiError(400,'Укажите видимость бренда.');
    const cover=input.cover??null;
    if(cover!==null&&(typeof cover!=='string'||!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(cover)||cover.length>350000))throw new ApiError(400,'Обложка слишком большая или имеет неверный формат.');
    return this.transaction(()=>{
      const previous=id&&this.brand(id);
      if(id&&!previous)throw new ApiError(404,'Бренд не найден.');
      if(previous&&input.expectedRevision!==previous.revision)throw new ApiError(409,'Бренд уже изменён. Обновите страницу и откройте настройки заново.');
      if(this.brands(true).some(b=>b.id!==id&&groupKey(b.name)===groupKey(name)))throw new ApiError(409,'Бренд с таким названием уже существует.');
      if(!id&&this.brands(true).length>=100)throw new ApiError(400,'Можно создать до 100 брендов.');
      if(previous){
        const oldCategories=Array.isArray(previous.categories)?previous.categories:[];
        const renameMap=new Map();
        if(oldCategories.length===names.length) oldCategories.forEach((oldName,index)=>{
          const nextName=names[index];
          if(groupKey(oldName)!==groupKey(nextName))renameMap.set(groupKey(oldName),nextName);
        });
        for(const row of this.rows('SELECT data,placed FROM products WHERE shipment=?',id)){
          const p=JSON.parse(row.data),mapped=renameMap.get(groupKey(p.group));
          if(mapped){p.group=mapped;this.sql.exec('UPDATE products SET data=? WHERE shipment=? AND id=?',JSON.stringify(p),id,p.id);}
          if((!p.hidden||row.placed>0)&&p.group&&!names.some(n=>groupKey(n)===groupKey(p.group)))throw new ApiError(409,`В категории «${p.group}» есть товары. Сначала переименуйте её или перенесите товары.`);
        }
      }
      const brand={id:id||'brand-'+crypto.randomUUID(),name,categories:names,cover,hidden:input.hidden,revision:(previous?.revision||0)+1};
      this.sql.exec('INSERT INTO brands(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',brand.id,JSON.stringify(brand));
      const shipment=this.one('SELECT data FROM shipments WHERE id=?',brand.id);
      if(shipment){const data={...JSON.parse(shipment.data),title:name,brand:name,groups:names};this.sql.exec('UPDATE shipments SET data=? WHERE id=?',JSON.stringify(data),brand.id);}
      return brand;
    });
  }
  catalog(admin=false) {
    return this.rows('SELECT data FROM shipments').map(r=>JSON.parse(r.data)).filter(s=>this.brand(s.id) && (admin || !this.brand(s.id).hidden&&s.status !== 'draft')).map(s=>{
      const groups=s.groupingMode==='manual'?(s.groups||[]):[];
      const retail=s.stockMode==='live';
      const products=this.rows('SELECT * FROM products WHERE shipment=? ORDER BY rowid',s.id).map((row,index)=>{
        const {subgroup,group,...p}=JSON.parse(row.data);
        return {...p,group:groups.find(g=>groupKey(g)===groupKey(group))||'',position:p.position??index,stock:row.total-row.placed,...(admin?{total:row.total,placed:row.placed}:{})};
      }).filter(p=>admin || !retail || (!p.hidden && p.stock>0)).sort((a,b)=>a.position-b.position);
      const {cover,...brandInfo}=this.brand(s.id);
      return {...s,title:brandInfo.name,brand:brandInfo.name,brandInfo,hidden:brandInfo.hidden,groups,products};
    });
  }
  deleteShipment(id) {
    if(!validId(id))throw new ApiError(400,'Некорректный каталог.');
    return this.transaction(()=>{
      if(!this.one('SELECT id FROM shipments WHERE id=?',id))return {deleted:true};
      const active=this.one("SELECT id FROM orders WHERE shipment=? AND status IN ('placed','confirmed') LIMIT 1",id);
      if(active || this.one('SELECT id FROM products WHERE shipment=? AND placed>0 LIMIT 1',id))throw new ApiError(409,'В каталоге есть действующие заказы.');
      this.sql.exec('DELETE FROM products WHERE shipment=?',id);
      this.sql.exec('DELETE FROM shipments WHERE id=?',id);
      // Order snapshots and notification history remain available to the owner.
      return {deleted:true};
    });
  }
  importShipment(input) {
    const brand=this.brand(input.id);
    if(!brand)throw new ApiError(400,'Сначала создайте бренд в разделе управления.');
    if(input.expectedBrandRevision!==undefined&&input.expectedBrandRevision!==brand.revision)throw new ApiError(409,'Настройки бренда изменились. Откройте каталог заново.');
    if(input.publishBrand!==undefined&&typeof input.publishBrand!=='boolean')throw new ApiError(400,'Некорректная видимость бренда.');
    if (!validId(input.id) || !trim(input.title,160) || !STATUSES.has(input.status) || !Array.isArray(input.products) || !input.products.length || input.products.length>3000) throw new ApiError(400,'Проверьте название, статус и список товаров.');
    for (const d of [input.eta,input.publishedAt]) if (d != null && d !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d)) throw new ApiError(400,'Некорректная дата.');
    const importCategory=input.importCategory===undefined?null:brand.categories.find(name=>typeof input.importCategory==='string'&&groupKey(name)===groupKey(input.importCategory));
    if(input.importCategory!==undefined&&(!importCategory||input.stockMode!=='live'))throw new ApiError(400,'Выберите существующую категорию для загрузки Excel.');
    const old = this.one('SELECT data FROM shipments WHERE id=?',input.id);
    const previous = old ? JSON.parse(old.data) : null;
    if(input.groupingMode!==undefined&&input.groupingMode!=='manual')throw new ApiError(400,'Некорректный режим групп.');
    const groups=input.groupingMode==='manual'?(input.groups??[]):[];
    if(!Array.isArray(groups)||groups.length>100||groups.some(g=>typeof g!=='string'||!g.trim()||g.length>80)||new Set(groups.map(groupKey)).size!==groups.length)throw new ApiError(400,'Укажите до 100 групп с уникальными названиями до 80 символов.');
    const fixedCategories=input.stockMode==='live'?brand.categories:null;
    const groupNames=fixedCategories?[...fixedCategories]:groups.map(g=>g.trim().replace(/\s+/g,' '));
    const shipment = {id:input.id,title:brand.name,brand:brand.name,description:trim(input.description,3000),status:input.status,stockMode:input.stockMode==='live'?'live':(previous?.stockMode||'legacy'),groupingMode:'manual',groups:groupNames,eta:input.eta || null,
      publishedAt:input.publishedAt || previous?.publishedAt || (input.status === 'draft'?null:new Date().toISOString().slice(0,10))};
    const ids = new Set();
    const products = input.products.map((p,position)=>{
      const stock=p.stock ?? p.total;
      if (!validId(p.id) || ids.has(p.id) || !trim(p.name,500) || !Number.isSafeInteger(stock) || stock<0 || stock>10000000 || !Number.isSafeInteger(p.price) || p.price<0 || p.price>100000000) throw new ApiError(400,'В товарах есть некорректный артикул, количество, цена или дубликат.');
      if(p.prices!==undefined&&(!validPrices(p.prices)||p.price!==p.prices[0]))throw new ApiError(400,'Проверьте цены Опт 1, Опт 2, Опт 3.');
      ids.add(p.id);
      if (p.image && (typeof p.image!=='string'||!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(p.image))) throw new ApiError(400,`${p.sku||p.id}: неверный формат фотографии. Загрузите Excel заново.`);
      if (p.image?.length>180000) throw new ApiError(400,`${p.sku||p.id}: фотография слишком большая. Обновите приложение и загрузите Excel заново для сжатия.`);
      if (p.imageKey && !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(p.imageKey)) throw new ApiError(400,'Некорректное изображение.');
      if(input.groupingMode==='manual'&&p.group!==undefined&&(typeof p.group!=='string'||p.group.length>80))throw new ApiError(400,'Некорректная группа товара.');
      const group=importCategory||(input.groupingMode==='manual'?trim(p.group,80):'');
      const groupName=groupNames.find(g=>groupKey(g)===groupKey(group));
      if(fixedCategories&&!groupName)throw new ApiError(400,`${p.sku||p.id}: выберите категорию товара.`);
      if(group&&!groupName)throw new ApiError(400,'Выберите существующую категорию товара.');
      return {id:p.id,sku:trim(p.sku || p.id,80),name:trim(p.name,500),group:groupName||'',position,price:p.price,...(p.prices?{prices:p.prices}:{}),unit:trim(p.unit || 'шт',20),image:p.image || null,imageKey:p.imageKey || null,stock,total:stock};
    });
    return this.transaction(()=>{
      if(shipment.stockMode==='live') {
        const current=this.rows('SELECT id,placed,total,data FROM products WHERE shipment=?',shipment.id);
        const byId=new Map(current.map(p=>[p.id,p]));
        if(importCategory){
          for(const p of products){const row=byId.get(p.id);if(row&&groupKey(JSON.parse(row.data).group)!==groupKey(importCategory))throw new ApiError(409,`${p.sku}: артикул уже используется в другой категории. Укажите отдельный артикул для этого товара.`);}
          if(previous)Object.assign(shipment,previous,{groups:brand.categories,title:brand.name,brand:brand.name});
        }

        this.sql.exec('INSERT INTO shipments(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',shipment.id,JSON.stringify(shipment));
        for(const p of products) {
          const existing=byId.get(p.id),placed=existing?.placed||0,total=p.stock+placed;
          const stored={...p,addedAt:existing?(JSON.parse(existing.data).addedAt||previous?.publishedAt||'1970-01-01'):new Date().toISOString(),hidden:false};
          this.sql.exec('INSERT INTO products(shipment,id,data,total) VALUES(?,?,?,?) ON CONFLICT(shipment,id) DO UPDATE SET data=excluded.data,total=excluded.total',shipment.id,p.id,JSON.stringify(stored),total);
        }
        for(const row of current) if(!ids.has(row.id)&&(!importCategory||groupKey(JSON.parse(row.data).group)===groupKey(importCategory))) {
          const previous=JSON.parse(row.data);
          const hidden={...previous,hidden:true,stock:0};
          this.sql.exec('UPDATE products SET data=?,total=? WHERE shipment=? AND id=?',JSON.stringify(hidden),row.placed,shipment.id,row.id);
        }
      } else {
        const current=this.rows('SELECT id,placed,data FROM products WHERE shipment=?',shipment.id);
        for(const p of current) if(p.placed && !ids.has(p.id)) throw new ApiError(409,'Нельзя удалить товар с действующими заказами.');
        const byId=new Map(current.map(p=>[p.id,p]));
        for(const p of products) {
          const existing=byId.get(p.id);
          if((existing?.placed || 0)>p.total) throw new ApiError(409,`${p.sku}: количество меньше уже оформленного в заказах.`);
        }
        this.sql.exec('INSERT INTO shipments(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',shipment.id,JSON.stringify(shipment));
        for(const p of products) this.sql.exec('INSERT INTO products(shipment,id,data,total) VALUES(?,?,?,?) ON CONFLICT(shipment,id) DO UPDATE SET data=excluded.data,total=excluded.total',shipment.id,p.id,JSON.stringify({...p,addedAt:byId.has(p.id)?(JSON.parse(byId.get(p.id).data).addedAt||previous?.publishedAt||'1970-01-01'):new Date().toISOString()}),p.total);
        for(const p of current) if(!ids.has(p.id)) this.sql.exec('DELETE FROM products WHERE shipment=? AND id=?',shipment.id,p.id);
      }
      if(input.publishBrand!==undefined&&brand.hidden===input.publishBrand)this.sql.exec('UPDATE brands SET data=? WHERE id=?',JSON.stringify({...brand,hidden:!input.publishBrand,revision:brand.revision+1}),brand.id);
      return shipment;
    });
  }
  normalizeLines(input,fallback) {
    if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>100)throw new ApiError(400,'Выберите от 1 до 100 позиций.');
    const seen=new Set();
    return input.lines.map(l=>{
      const shipmentId=l?.shipmentId??fallback,key=lineKey({shipmentId,id:l?.id});
      if(!l||!validId(shipmentId)||!validId(l.id)||seen.has(key)||!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>10000000)throw new ApiError(400,'Некорректное количество или повтор товара.');
      if(l.expectedPrice!==undefined&&(!Number.isSafeInteger(l.expectedPrice)||l.expectedPrice<0||l.expectedPrice>100000000))throw new ApiError(400,'Некорректная цена.');
      seen.add(key);
      return {id:l.id,quantity:l.quantity,...(l.shipmentId!==undefined?{shipmentId}:{}),...(l.expectedPrice!==undefined?{expectedPrice:l.expectedPrice}:{})};
    }).sort((a,b)=>(a.shipmentId||'').localeCompare(b.shipmentId||'')||a.id.localeCompare(b.id));
  }
  placeOrder(user,input) {
    if(!validId(input.requestKey))throw new ApiError(400,'Некорректный ключ заказа.');
    const lines=this.normalizeLines(input,input.shipmentId),comment=trim(input.comment,1000);
    const explicitBrands=lines.some(l=>l.shipmentId!==undefined);
    // Keep the legacy fingerprint format so retries from already-open clients still work.
    const fingerprint=JSON.stringify({shipment:input.shipmentId,lines,comment});
    return this.transaction(()=>{
      const previous=this.one('SELECT * FROM orders WHERE user_id=? AND request_key=?',user.id,input.requestKey);
      if(previous) {
        if(previous.fingerprint!==fingerprint)throw new ApiError(409,'Повтор запроса с другим содержимым.');
        const {manager,...data}=JSON.parse(previous.data);
        return {...data,status:previous.status,repeated:true};
      }
      const catalogs=new Map();
      let detailed=lines.map(l=>{
        const shipmentId=l.shipmentId??input.shipmentId;
        const shipmentRow=this.one('SELECT data FROM shipments WHERE id=?',shipmentId);
        const shipment=shipmentRow&&JSON.parse(shipmentRow.data);
        if(!shipment||!this.brand(shipmentId)||this.brand(shipmentId).hidden||!ACTIVE.has(shipment.status))throw new ApiError(409,'Заказы по этому каталогу закрыты.');
        catalogs.set(shipmentId,shipment.title);
        const row=this.one('SELECT * FROM products WHERE shipment=? AND id=?',shipmentId,l.id);
        if(!row)throw new ApiError(409,'Товар больше не доступен.');
        const product=JSON.parse(row.data);
        if(product.hidden)throw new ApiError(409,'Товар больше не доступен.');
        if(row.total-row.placed<l.quantity)throw new ApiError(409,`${product.sku}: свободно ${row.total-row.placed} шт. Проверьте корзину.`);

        return {id:l.id,...(explicitBrands?{shipmentId,shipmentTitle:shipment.title}:{}),sku:product.sku,name:product.name,quantity:l.quantity,price:product.price,prices:product.prices,wholesale:isRemaxGlass(this.brand(shipmentId),product)};
      });
      detailed=priceLines(detailed);
      for(let i=0;i<lines.length;i++)if(lines[i].expectedPrice!==undefined&&lines[i].expectedPrice!==detailed[i].price)throw new ApiError(409,'Цена изменилась. Проверьте заказ.');
      const shipmentIds=[...catalogs.keys()],shipmentId=shipmentIds.length===1?shipmentIds[0]:'mixed';
      const data={id:crypto.randomUUID(),shipmentId,shipmentIds,shipmentTitle:[...catalogs.values()].join(' + '),user,lines:detailed,comment,status:'placed',revision:1,createdAt:new Date().toISOString(),total:detailed.reduce((sum,l)=>sum+l.price*l.quantity,0)};
      if(!Number.isSafeInteger(data.total))throw new ApiError(400,'Слишком большая сумма.');
      if(input.enforceMinimum===true && detailed.some(l=>l.wholesale) && data.total<MIN_ORDER)throw new ApiError(400,'Минимальный заказ от 10.000 рублей.');
      for(const l of detailed)this.sql.exec('UPDATE products SET placed=placed+? WHERE shipment=? AND id=?',l.quantity,l.shipmentId??shipmentId,l.id);
      this.sql.exec('INSERT INTO orders(id,user_id,request_key,fingerprint,shipment,status,data) VALUES(?,?,?,?,?,?,?)',data.id,user.id,input.requestKey,fingerprint,shipmentId,data.status,JSON.stringify(data));
      this.enqueue(data,'created');return data;
    });
  }
  editOrder(user,id,input,admin=false) {
    if(!validId(input.requestKey)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw new ApiError(400,'Некорректный запрос изменения заказа.');
    return this.transaction(()=>{
      const row=this.one('SELECT * FROM orders WHERE id=?',id);
      if(!row||(!admin&&row.user_id!==user.id))throw new ApiError(404,'Заказ не найден.');
      const {manager,...previous}=JSON.parse(row.data),revision=previous.revision||1;
      const lines=this.normalizeLines(input,row.shipment),comment=trim(input.comment,1000);
      const fingerprint=JSON.stringify({id,revision:input.expectedRevision,lines,comment});
      const retry=this.one('SELECT fingerprint FROM order_edits WHERE user_id=? AND request_key=?',user.id,input.requestKey);
      if(retry){
        if(retry.fingerprint!==fingerprint)throw new ApiError(409,'Повтор запроса с другим содержимым.');
        return {...previous,status:row.status,repeated:true};
      }
      if(row.status==='cancelled'||(!admin&&row.status==='confirmed'))throw new ApiError(409,'Этот заказ нельзя изменить. Для подтверждённого заказа обратитесь в магазин.');
      if(revision!==input.expectedRevision)throw new ApiError(409,'Заказ уже изменён. Обновите список заказов и откройте его заново.');
      const old=new Map(previous.lines.map(l=>{const item={...l,shipmentId:l.shipmentId??row.shipment};return [lineKey(item),item];}));
      const catalogs=new Map();
      let detailed=lines.map(line=>{
        const l={...line,shipmentId:line.shipmentId??row.shipment};
        const shipmentRow=this.one('SELECT data FROM shipments WHERE id=?',l.shipmentId),shipment=shipmentRow&&JSON.parse(shipmentRow.data);
        if(!shipment||(!admin&&(!this.brand(l.shipmentId)||this.brand(l.shipmentId).hidden||!ACTIVE.has(shipment.status))))throw new ApiError(409,'Изменение этого каталога закрыто. Обратитесь в магазин.');
        catalogs.set(l.shipmentId,shipment.title);
        const productRow=this.one('SELECT * FROM products WHERE shipment=? AND id=?',l.shipmentId,l.id);
        if(!productRow)throw new ApiError(409,'Товар больше не доступен.');
        const product=JSON.parse(productRow.data),existing=old.get(lineKey(l));
        if(product.hidden&&!existing)throw new ApiError(409,'Товар больше не доступен.');
        const available=productRow.total-productRow.placed+(existing?.quantity||0);
        if(l.quantity>available)throw new ApiError(409,`${product.sku}: можно оставить максимум ${available} шт. с учётом вашего заказа.`);

        return {id:l.id,shipmentId:l.shipmentId,shipmentTitle:shipment.title,sku:existing?.sku||product.sku,name:existing?.name||product.name,quantity:l.quantity,price:existing?.price??product.price,prices:existing?existing.prices:product.prices,wholesale:existing?.wholesale??isRemaxGlass(this.brand(l.shipmentId),product)};
      });
      detailed=priceLines(detailed);
      for(let i=0;i<lines.length;i++)if(lines[i].expectedPrice!==undefined&&lines[i].expectedPrice!==detailed[i].price)throw new ApiError(409,'Цена изменилась. Проверьте заказ.');
      const shipmentIds=[...catalogs.keys()],shipmentId=shipmentIds.length===1?shipmentIds[0]:'mixed';
      const data={...previous,shipmentId,shipmentIds,shipmentTitle:[...catalogs.values()].join(' + '),lines:detailed,comment,status:row.status,revision:revision+1,editedAt:new Date().toISOString(),total:detailed.reduce((sum,l)=>sum+l.price*l.quantity,0)};
      if(!Number.isSafeInteger(data.total))throw new ApiError(400,'Слишком большая сумма.');
      if(input.enforceMinimum===true && detailed.some(l=>l.wholesale) && data.total<MIN_ORDER)throw new ApiError(400,'Минимальный заказ от 10.000 рублей.');
      const next=new Map(detailed.map(l=>[lineKey(l),l]));
      for(const key of new Set([...old.keys(),...next.keys()])) {
        const l=next.get(key)||old.get(key),delta=(next.get(key)?.quantity||0)-(old.get(key)?.quantity||0);
        if(delta)this.sql.exec('UPDATE products SET placed=placed+? WHERE shipment=? AND id=?',delta,l.shipmentId,l.id);
      }
      this.sql.exec('UPDATE orders SET shipment=?,data=? WHERE id=?',shipmentId,JSON.stringify(data),id);
      this.sql.exec('INSERT INTO order_edits(user_id,request_key,fingerprint) VALUES(?,?,?)',user.id,input.requestKey,fingerprint);
      this.enqueue(data,'edited');return data;
    });
  }
  orders(user,admin=false) {
    const rows=admin?this.rows('SELECT * FROM orders ORDER BY rowid DESC LIMIT 1000'):this.rows("SELECT * FROM orders WHERE user_id=? AND status!='cancelled' ORDER BY rowid DESC LIMIT 1000",user.id);
    return rows.map(r=>{const {manager,...data}=JSON.parse(r.data);return {...data,status:r.status};});
  }
  changeOrder(user,id,status,admin=false,expectedRevision) {
    if(!['cancelled','confirmed'].includes(status) || (!admin && status!=='cancelled')) throw new ApiError(403,'Недостаточно прав.');
    return this.transaction(()=>{
      const row=this.one('SELECT * FROM orders WHERE id=?',id);
      if(!row || (!admin && row.user_id!==user.id)) throw new ApiError(404,'Заказ не найден.');
      const stored=JSON.parse(row.data),{manager:legacyManager,...data}=stored;
      if(row.status===status) return {...data,status};
      if(expectedRevision!==undefined && expectedRevision!==(data.revision||1)) throw new ApiError(409,'Заказ уже изменён. Обновите список заказов.');
      if(row.status==='cancelled' || (!admin && row.status==='confirmed')) throw new ApiError(409,'Для изменения подтверждённого заказа свяжитесь с магазином.');
      if(status==='cancelled') for(const l of data.lines) this.sql.exec('UPDATE products SET placed=placed-? WHERE shipment=? AND id=?',l.quantity,l.shipmentId??data.shipmentId,l.id);
      const updated={...data,status,revision:(data.revision||1)+1};
      this.sql.exec('UPDATE orders SET status=?,data=? WHERE id=?',status,JSON.stringify(updated),id);
      this.enqueue(updated,status);
      return updated;
    });
  }
  notificationText(data) {
    const name=data.status==='cancelled'?'Заказ отменён':data.status==='confirmed'?'Заказ подтверждён':data.editedAt?'Заказ изменён':'Новый заказ';
    const who=`${data.user.name}${data.user.username?' @'+data.user.username:''} (ID ${data.user.id})`;
    return `${name} №${data.id}\nКлиент: ${who}\nБренд: ${data.shipmentTitle}${data.editedAt?'\nИзменён: '+data.editedAt.replace('T',' ').slice(0,19)+' UTC':''}\n\n${data.lines.map(l=>`${l.shipmentTitle?l.shipmentTitle+' · ':''}${l.sku} · ${l.name}\n${l.quantity} шт. × ${(l.price/100).toFixed(2)} ₽`).join('\n\n')}\n\nИтого: ${(data.total/100).toFixed(2)} ₽${data.comment?'\nКомментарий: '+data.comment:''}`;
  }
  enqueue(data,event) {
    const text=this.notificationText(data);
    this.sql.exec('INSERT OR IGNORE INTO outbox(id,data) VALUES(?,?)',`${data.id}:v${data.revision||1}:${event}`,JSON.stringify({orderId:data.id,text,kind:'order'}));
  }
}
