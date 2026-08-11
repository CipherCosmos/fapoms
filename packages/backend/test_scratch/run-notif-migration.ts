import { DataSource } from 'typeorm';
import { AddAssayerNotificationRecipient1786000000000 } from './infrastructure/database/migrations/1786000000000-AddAssayerNotificationRecipient';
const ds = new DataSource({ type:'postgres', host:process.env.DB_HOST||'postgres', port:5432,
  username:'fapoms', password:'fapoms_dev', database:'fapoms', synchronize:false, logging:false, entities:[], migrations:[] });
async function main(){
  await ds.initialize(); const qr = ds.createQueryRunner(); await qr.connect();
  await qr.startTransaction();
  try { await new AddAssayerNotificationRecipient1786000000000().up(qr); await qr.commitTransaction(); console.log('Committed.'); }
  catch(e){ await qr.rollbackTransaction(); console.error('FAILED, rolled back:', e); process.exitCode=1; }
  console.table(await qr.query(`SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name='notifications' AND column_name IN ('user_id','assayer_id') ORDER BY column_name`));
  await qr.release(); await ds.destroy();
}
main().catch(e=>{console.error(e);process.exit(1);});
