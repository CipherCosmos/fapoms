import { DataSource } from 'typeorm';
import { AddDocumentTransportTrail1785900000000 } from './infrastructure/database/migrations/1785900000000-AddDocumentTransportTrail';
const ds = new DataSource({ type:'postgres', host:process.env.DB_HOST||'postgres', port:5432,
  username:'fapoms', password:'fapoms_dev', database:'fapoms', synchronize:false, logging:false, entities:[], migrations:[] });
async function main(){
  await ds.initialize(); const qr = ds.createQueryRunner(); await qr.connect();
  await qr.startTransaction();
  try { await new AddDocumentTransportTrail1785900000000().up(qr); await qr.commitTransaction(); console.log('Committed.'); }
  catch(e){ await qr.rollbackTransaction(); console.error('FAILED, rolled back:', e); process.exitCode=1; }
  console.table(await qr.query(`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name='documents' AND column_name IN
    ('dispatched_at','dispatch_method','dispatched_by','received_at','sent_to_data_entry_at','sent_to_external_ocr_at')
    ORDER BY column_name`));
  await qr.release(); await ds.destroy();
}
main().catch(e=>{console.error(e);process.exit(1);});
