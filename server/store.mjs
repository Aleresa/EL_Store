import {ApiError} from './auth.mjs';
import {groupKey} from '../public/product-groups.js';

const ACTIVE = new Set(['arrived']);
const STATUSES = new Set(['draft','arrived','closed']);
const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
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
    sql.exec('CREATE TABLE IF NOT EXISTS managers (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  }
  rows(query,...bindings) { return [...this.sql.exec(query,...bindings)]; }
  one(query,...bindings) { return this.rows(query,...bindings)[0]; }
  managers() { return this.rows('SELECT data FROM managers ORDER BY rowid').map(r=>JSON.parse(r.data)); }
  saveManagers(input) {
    if(!Array.isArray(input.managers) || input.managers.length>100) throw new ApiError(400,'Допустимо не больше 100 менеджеров.');
    const ids=new Set(),usernames=new Set();
    const managers=input.managers.map(m=>{
      if(!m || typeof m!=='object') throw new ApiError(400,'Проверьте список менеджеров.');
      const name=trim(m.name,80),username=trim(m.username,80).replace(/^@/,'');
      if(!validId(m.id) || ids.has(m.id) || !name || /[\r\n]/.test(name) || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(username) || usernames.has(username.toLowerCase())) throw new ApiError(400,'Укажите имя и уникальный Telegram-ник менеджера, например @manager_name.');
      ids.add(m.id);usernames.add(username.toLowerCase());
      return {id:m.id,name,username};
    });
    return this.transaction(()=>{
      this.sql.exec('DELETE FROM managers');
      for(const m of managers)this.sql.exec('INSERT INTO managers(id,data) VALUES(?,?)',m.id,JSON.stringify(m));
      return managers;
    });
  }
  catalog(admin=false) {
    return this.rows('SELECT data FROM shipments').map(r=>JSON.parse(r.data)).filter(s=>admin || s.status !== 'draft').map(s=>{
      const groups=s.groupingMode==='manual'?(s.groups||[]):[];
      const products=this.rows('SELECT * FROM products WHERE shipment=? ORDER BY rowid',s.id).map((row,index)=>{
        const {subgroup,group,...p}=JSON.parse(row.data);
        return {...p,group:groups.find(g=>groupKey(g)===groupKey(group))||'',position:p.position??index,stock:row.total-row.placed,...(admin?{total:row.total,placed:row.placed}:{})};
      }).sort((a,b)=>a.position-b.position);
      return {...s,groups,products};
    });
  }
  deleteShipment(id) {
    if(!validId(id))throw new ApiError(400,'Некорректное поступление.');
    return this.transaction(()=>{
      if(!this.one('SELECT id FROM shipments WHERE id=?',id))return {deleted:true};
      const active=this.one("SELECT id FROM orders WHERE shipment=? AND status IN ('placed','confirmed') LIMIT 1",id);
      if(active || this.one('SELECT id FROM products WHERE shipment=? AND placed>0 LIMIT 1',id))throw new ApiError(409,'В поступлении есть действующие заказы. Для остановки новых заказов закройте поступление в настройках.');
      this.sql.exec('DELETE FROM products WHERE shipment=?',id);
      this.sql.exec('DELETE FROM shipments WHERE id=?',id);
      // Order snapshots and notification history remain available to the owner.
      return {deleted:true};
    });
  }
  importShipment(input) {
    if (!validId(input.id) || !trim(input.title,160) || !STATUSES.has(input.status) || !Array.isArray(input.products) || !input.products.length || input.products.length>3000) throw new ApiError(400,'Проверьте название, статус и список товаров.');
    for (const d of [input.eta,input.publishedAt]) if (d != null && d !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d)) throw new ApiError(400,'Некорректная дата.');
    const old = this.one('SELECT data FROM shipments WHERE id=?',input.id);
    const previous = old ? JSON.parse(old.data) : null;
    if(input.groupingMode!==undefined&&input.groupingMode!=='manual')throw new ApiError(400,'Некорректный режим групп.');
    const groups=input.groupingMode==='manual'?(input.groups??[]):[];
    if(!Array.isArray(groups)||groups.length>100||groups.some(g=>typeof g!=='string'||!g.trim()||g.length>80)||new Set(groups.map(groupKey)).size!==groups.length)throw new ApiError(400,'Укажите до 100 групп с уникальными названиями до 80 символов.');
    const groupNames=groups.map(g=>g.trim().replace(/\s+/g,' '));
    const shipment = {id:input.id,title:trim(input.title,160),brand:trim(input.brand,80),description:trim(input.description,3000),status:input.status,groupingMode:'manual',groups:groupNames,eta:input.eta || null,
      publishedAt:input.publishedAt || previous?.publishedAt || (input.status === 'draft'?null:new Date().toISOString().slice(0,10))};
    const ids = new Set();
    const products = input.products.map((p,position)=>{
      const total=p.total ?? p.stock;
      if (!validId(p.id) || ids.has(p.id) || !trim(p.name,500) || !Number.isSafeInteger(total) || total<0 || total>10000000 || !Number.isSafeInteger(p.price) || p.price<0 || p.price>100000000) throw new ApiError(400,'В товарах есть некорректный артикул, количество, цена или дубликат.');
      ids.add(p.id);
      if (p.image && (!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(p.image) || p.image.length>180000)) throw new ApiError(400,'Некорректное изображение.');
      if (p.imageKey && !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(p.imageKey)) throw new ApiError(400,'Некорректное изображение.');
      if(input.groupingMode==='manual'&&p.group!==undefined&&(typeof p.group!=='string'||p.group.length>80))throw new ApiError(400,'Некорректная группа товара.');
      const group=input.groupingMode==='manual'?trim(p.group,80):'';
      const groupName=groupNames.find(g=>groupKey(g)===groupKey(group));
      if(group&&!groupName)throw new ApiError(400,'Сначала создайте группу для товара.');
      return {id:p.id,sku:trim(p.sku || p.id,80),name:trim(p.name,500),group:groupName||'',position,price:p.price,unit:trim(p.unit || 'шт',20),image:p.image || null,imageKey:p.imageKey || null,total};
    });
    return this.transaction(()=>{
      const current=this.rows('SELECT id,placed FROM products WHERE shipment=?',shipment.id);
      for(const p of current) if(p.placed && !ids.has(p.id)) throw new ApiError(409,'Нельзя удалить товар с действующими заказами.');
      const byId=new Map(current.map(p=>[p.id,p]));
      for(const p of products) {
        const existing=byId.get(p.id);
        if((existing?.placed || 0)>p.total) throw new ApiError(409,`${p.sku}: количество меньше уже оформленного в заказах.`);
      }
      this.sql.exec('INSERT INTO shipments(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',shipment.id,JSON.stringify(shipment));
      for(const p of products) this.sql.exec('INSERT INTO products(shipment,id,data,total) VALUES(?,?,?,?) ON CONFLICT(shipment,id) DO UPDATE SET data=excluded.data,total=excluded.total',shipment.id,p.id,JSON.stringify(p),p.total);
      for(const p of current) if(!ids.has(p.id)) this.sql.exec('DELETE FROM products WHERE shipment=? AND id=?',shipment.id,p.id);
      return shipment;
    });
  }
  placeOrder(user,input) {
    if(!validId(input.shipmentId) || !validId(input.requestKey) || !Array.isArray(input.lines) || !input.lines.length || input.lines.length>100) throw new ApiError(400,'Выберите от 1 до 100 позиций.');
    const seen=new Set();
    const lines=input.lines.map(l=>{
      if(!validId(l.id) || seen.has(l.id) || !Number.isSafeInteger(l.quantity) || l.quantity<1 || l.quantity>10000000) throw new ApiError(400,'Некорректное количество или повтор товара.');
      seen.add(l.id); return {id:l.id,quantity:l.quantity};
    }).sort((a,b)=>a.id.localeCompare(b.id));
    const comment=trim(input.comment,1000);
    if(input.managerId!==undefined && !validId(input.managerId)) throw new ApiError(400,'Выберите менеджера.');
    const fingerprint=JSON.stringify({shipment:input.shipmentId,lines,comment,...(input.managerId?{managerId:input.managerId}:{})});
    return this.transaction(()=>{
      const previous=this.one('SELECT * FROM orders WHERE user_id=? AND request_key=?',user.id,input.requestKey);
      if(previous) {
        if(previous.fingerprint!==fingerprint) throw new ApiError(409,'Повтор запроса с другим содержимым.');
        return {...JSON.parse(previous.data),status:previous.status,repeated:true};
      }
      const manager=this.managers().find(m=>m.id===input.managerId);
      if(!manager) throw new ApiError(400,'Выберите менеджера из актуального списка. Если список пуст, обратитесь в магазин.');
      const shipmentRow=this.one('SELECT data FROM shipments WHERE id=?',input.shipmentId);
      const shipment=shipmentRow && JSON.parse(shipmentRow.data);
      if(!shipment || !ACTIVE.has(shipment.status)) throw new ApiError(409,'Заказы по этому поступлению закрыты.');
      const detailed=lines.map(l=>{
        const row=this.one('SELECT * FROM products WHERE shipment=? AND id=?',input.shipmentId,l.id);
        if(!row) throw new ApiError(409,'Товар больше не доступен.');
        const product=JSON.parse(row.data);
        if(row.total-row.placed<l.quantity) throw new ApiError(409,`${product.sku}: свободно ${row.total-row.placed} шт. Обновите количество.`);
        return {id:l.id,sku:product.sku,name:product.name,quantity:l.quantity,price:product.price};
      });
      const data={id:crypto.randomUUID(),shipmentId:shipment.id,shipmentTitle:shipment.title,user,manager,lines:detailed,comment,status:'placed',revision:1,createdAt:new Date().toISOString(),total:detailed.reduce((s,l)=>s+l.price*l.quantity,0)};
      if(!Number.isSafeInteger(data.total)) throw new ApiError(400,'Слишком большая сумма.');
      for(const l of detailed) this.sql.exec('UPDATE products SET placed=placed+? WHERE shipment=? AND id=?',l.quantity,shipment.id,l.id);
      this.sql.exec('INSERT INTO orders(id,user_id,request_key,fingerprint,shipment,status,data) VALUES(?,?,?,?,?,?,?)',data.id,user.id,input.requestKey,fingerprint,shipment.id,data.status,JSON.stringify(data));
      this.enqueue(data,'created');
      return data;
    });
  }
  editOrder(user,id,input,admin=false) {
    if(!validId(input.requestKey) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<1 || !Array.isArray(input.lines) || !input.lines.length || input.lines.length>100) throw new ApiError(400,'Оставьте от 1 до 100 позиций. Для полного отказа отмените заказ.');
    const seen=new Set();
    const lines=input.lines.map(l=>{
      if(!l || !validId(l.id) || seen.has(l.id) || !Number.isSafeInteger(l.quantity) || l.quantity<1 || l.quantity>10000000) throw new ApiError(400,'Некорректное количество или повтор товара.');
      seen.add(l.id);return {id:l.id,quantity:l.quantity};
    }).sort((a,b)=>a.id.localeCompare(b.id));
    const comment=trim(input.comment,1000),fingerprint=JSON.stringify({id,revision:input.expectedRevision,lines,comment});
    return this.transaction(()=>{
      const row=this.one('SELECT * FROM orders WHERE id=?',id);
      if(!row || (!admin && row.user_id!==user.id)) throw new ApiError(404,'Заказ не найден.');
      const previous=JSON.parse(row.data),revision=previous.revision||1;
      const retry=this.one('SELECT fingerprint FROM order_edits WHERE user_id=? AND request_key=?',user.id,input.requestKey);
      if(retry){
        if(retry.fingerprint!==fingerprint) throw new ApiError(409,'Повтор запроса с другим содержимым.');
        return {...previous,status:row.status,repeated:true};
      }
      if(row.status==='cancelled' || (!admin && row.status==='confirmed')) throw new ApiError(409,'Этот заказ нельзя изменить. Для подтверждённого заказа обратитесь к менеджеру.');
      if(revision!==input.expectedRevision) throw new ApiError(409,'Заказ уже изменён. Обновите список заказов и откройте его заново.');
      const shipmentRow=this.one('SELECT data FROM shipments WHERE id=?',row.shipment);
      if(!shipmentRow || (!admin && !ACTIVE.has(JSON.parse(shipmentRow.data).status))) throw new ApiError(409,'Изменение этого поступления закрыто. Обратитесь к менеджеру.');
      const old=new Map(previous.lines.map(l=>[l.id,l]));
      const detailed=lines.map(l=>{
        const productRow=this.one('SELECT * FROM products WHERE shipment=? AND id=?',row.shipment,l.id);
        if(!productRow) throw new ApiError(409,'Товар больше не доступен.');
        const product=JSON.parse(productRow.data),existing=old.get(l.id);
        const available=productRow.total-productRow.placed+(existing?.quantity||0);
        if(l.quantity>available) throw new ApiError(409,`${product.sku}: можно оставить максимум ${available} шт. с учётом вашего заказа.`);
        // Preserve the agreed unit price for existing lines; new products use the current server price.
        return {id:l.id,sku:existing?.sku||product.sku,name:existing?.name||product.name,quantity:l.quantity,price:existing?.price??product.price};
      });
      const data={...previous,lines:detailed,comment,status:row.status,revision:revision+1,editedAt:new Date().toISOString(),total:detailed.reduce((sum,l)=>sum+l.price*l.quantity,0)};
      if(!Number.isSafeInteger(data.total)) throw new ApiError(400,'Слишком большая сумма.');
      const next=new Map(detailed.map(l=>[l.id,l.quantity]));
      for(const productId of new Set([...old.keys(),...next.keys()])) {
        const delta=(next.get(productId)||0)-(old.get(productId)?.quantity||0);
        if(delta)this.sql.exec('UPDATE products SET placed=placed+? WHERE shipment=? AND id=?',delta,row.shipment,productId);
      }
      this.sql.exec('UPDATE orders SET data=? WHERE id=?',JSON.stringify(data),id);
      this.sql.exec('INSERT INTO order_edits(user_id,request_key,fingerprint) VALUES(?,?,?)',user.id,input.requestKey,fingerprint);
      this.enqueue(data,'edited');
      return data;
    });
  }
  orders(user,admin=false) {
    const rows=admin?this.rows('SELECT * FROM orders ORDER BY rowid DESC LIMIT 1000'):this.rows("SELECT * FROM orders WHERE user_id=? AND status!='cancelled' ORDER BY rowid DESC LIMIT 1000",user.id);
    return rows.map(r=>({...JSON.parse(r.data),status:r.status}));
  }
  changeOrder(user,id,status,admin=false,expectedRevision) {
    if(!['cancelled','confirmed'].includes(status) || (!admin && status!=='cancelled')) throw new ApiError(403,'Недостаточно прав.');
    return this.transaction(()=>{
      const row=this.one('SELECT * FROM orders WHERE id=?',id);
      if(!row || (!admin && row.user_id!==user.id)) throw new ApiError(404,'Заказ не найден.');
      const data=JSON.parse(row.data);
      if(row.status===status) return {...data,status};
      if(expectedRevision!==undefined && expectedRevision!==(data.revision||1)) throw new ApiError(409,'Заказ уже изменён. Обновите список заказов.');
      if(row.status==='cancelled' || (!admin && row.status==='confirmed')) throw new ApiError(409,'Для изменения подтверждённого заказа свяжитесь с менеджером.');
      if(status==='cancelled') for(const l of data.lines) this.sql.exec('UPDATE products SET placed=placed-? WHERE shipment=? AND id=?',l.quantity,data.shipmentId,l.id);
      const updated={...data,status,revision:(data.revision||1)+1};
      this.sql.exec('UPDATE orders SET status=?,data=? WHERE id=?',status,JSON.stringify(updated),id);
      this.enqueue(updated,status);
      return updated;
    });
  }
  notificationText(data) {
    const name=data.status==='cancelled'?'Заказ отменён':data.status==='confirmed'?'Заказ подтверждён':data.editedAt?'Заказ изменён':'Новый заказ';
    const who=`${data.user.name}${data.user.username?' @'+data.user.username:''} (ID ${data.user.id})`;
    return `${name} №${data.id}${data.manager?'\nМенеджер: '+data.manager.name+' @'+data.manager.username:''}\nКлиент: ${who}\nПоступление: ${data.shipmentTitle}${data.editedAt?'\nИзменён: '+data.editedAt.replace('T',' ').slice(0,19)+' UTC':''}\n\n${data.lines.map(l=>`${l.sku} · ${l.name}\n${l.quantity} шт. × ${(l.price/100).toFixed(2)} ₽`).join('\n\n')}\n\nИтого: ${(data.total/100).toFixed(2)} ₽${data.comment?'\nКомментарий: '+data.comment:''}`;
  }
  enqueue(data,event) {
    const text=this.notificationText(data);
    this.sql.exec('INSERT OR IGNORE INTO outbox(id,data) VALUES(?,?)',`${data.id}:v${data.revision||1}:${event}`,JSON.stringify({orderId:data.id,text,kind:'manager'}));
  }
}
