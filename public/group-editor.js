import {groupKey} from './product-groups.js';
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function mountGroupEditor(container,products,groups){
  function render(){
    container.innerHTML=`<section class="group-review"><h3>Группы товаров — необязательно</h3><p class="fine-print">Создайте группы и выберите группу у нужных товаров. Без распределения товары будут показаны в порядке файла, без групп и фильтров.</p><div class="group-create"><label class="field">Название новой группы<input id="new-product-group" maxlength="80" placeholder="Например, Кабели"></label><button type="button" class="secondary" id="add-product-group">Создать группу</button></div><p class="error" data-group-error role="alert"></p><div class="group-list">${groups.map((g,i)=>`<div class="group-rename"><label class="field">Группа<input data-rename-input="${i}" maxlength="80" value="${esc(g)}"></label><button type="button" class="secondary" data-rename-group="${i}" aria-label="Переименовать ${esc(g)}">Сохранить</button><button type="button" class="danger" data-delete-group="${i}" aria-label="Удалить ${esc(g)}">Удалить</button></div>`).join('')}</div>${groups.length?`<button type="button" class="secondary" id="clear-product-groups">Убрать все группы</button><div class="group-editor-products">${products.map((p,i)=>`<article class="group-editor-product"><strong>${esc(p.name)}</strong><small class="muted">Артикул ${esc(p.sku)}</small><label class="field">Группа<select data-product-group="${esc(p.id)}" data-index="${i}"><option value="">Без группы</option>${groups.map(g=>`<option value="${esc(g)}" ${groupKey(g)===groupKey(p.group)?'selected':''}>${esc(g)}</option>`).join('')}</select></label></article>`).join('')}</div>`:'<p class="fine-print">Групп пока нет. Можно сразу сохранить поступление.</p>'}</section>`;
    const error=container.querySelector('[data-group-error]');
    function nameFrom(input,index=-1){
      const value=input.value.trim().replace(/\s+/g,' ');
      if(!value){error.textContent='Введите название группы.';input.focus();return;}
      if(groups.some((g,i)=>i!==index&&groupKey(g)===groupKey(value))){error.textContent='Группа с таким названием уже есть.';return;}
      return value;
    }
    const add=()=>{const name=nameFrom(container.querySelector('#new-product-group'));if(!name)return;if(groups.length>=100){error.textContent='Можно создать до 100 групп.';return;}groups.push(name);render();};
    container.querySelector('#add-product-group').onclick=add;
    container.querySelector('#new-product-group').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();add();}};
    container.querySelectorAll('[data-product-group]').forEach(select=>select.onchange=()=>products[Number(select.dataset.index)].group=select.value);
    container.querySelectorAll('[data-rename-group]').forEach(button=>button.onclick=()=>{const i=Number(button.dataset.renameGroup),name=nameFrom(container.querySelector(`[data-rename-input="${i}"]`),i);if(!name)return;for(const p of products)if(groupKey(p.group)===groupKey(groups[i]))p.group=name;groups[i]=name;render();});
    container.querySelectorAll('[data-delete-group]').forEach(button=>button.onclick=()=>{const i=Number(button.dataset.deleteGroup);for(const p of products)if(groupKey(p.group)===groupKey(groups[i]))p.group='';groups.splice(i,1);render();});
    const clear=container.querySelector('#clear-product-groups');if(clear)clear.onclick=()=>{groups.splice(0);for(const p of products)p.group='';render();};
  }
  render();
}
