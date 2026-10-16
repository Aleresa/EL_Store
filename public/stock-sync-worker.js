// Background-only parser: does not read or upload pictures, names, prices or groups.
importScripts('./vendor/sheetjs-0.20.3.min.js');
self.onmessage=async({data:buffer})=>{
  try{
    const {parseStockRows}=await import('./stock-rows.js');
    const workbook=XLSX.read(buffer,{type:'array',cellFormula:false,cellHTML:false,cellStyles:false});
    const sheet=workbook.Sheets[workbook.SheetNames[0]];
    if(!sheet)throw Error('В Excel не найден лист с товарами.');
    const rows=new Map();let count=0;
    for(const [address,cell] of Object.entries(sheet)){
      if(!/^[A-Z]+\d+$/.test(address))continue;
      if(++count>250000)throw Error('Слишком много заполненных ячеек.');
      const {r,c}=XLSX.utils.decode_cell(address),number=r+1;
      if(!rows.has(number))rows.set(number,{});
      rows.get(number)[c]=cell.t==='n'?(cell.w??cell.v):(cell.v??'');
    }
    self.postMessage(parseStockRows(new Map([...rows].sort(([a],[b])=>a-b))));
  }catch(error){self.postMessage({error:error.message||'Не удалось прочитать Excel.'});}
};
