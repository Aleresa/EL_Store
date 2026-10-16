import {validateExcelFile} from './excel-limits.js';
// Isolated from the regular goods + images importer.
export async function readStockExcel(file,{signal}={}){
  validateExcelFile(file);
  signal?.throwIfAborted();
  const buffer=await file.arrayBuffer();
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./stock-sync-worker.js',import.meta.url));
    let finished=false;
    const finish=(error,result)=>{
      if(finished)return;
      finished=true;worker.terminate();signal?.removeEventListener('abort',abort);clearTimeout(timer);
      error?reject(error):resolve(result);
    };
    const abort=()=>finish(new DOMException('Импорт отменён','AbortError'));
    const timer=setTimeout(()=>finish(Error('Чтение Excel заняло слишком много времени.')),240000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    worker.onerror=()=>finish(Error('Не удалось запустить чтение Excel.'));
    worker.onmessage=({data})=>finish(data.error?Error(data.error):null,data);
    worker.postMessage(buffer,[buffer]);
  });
}
