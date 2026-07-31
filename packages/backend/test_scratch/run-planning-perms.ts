import { DataSource } from 'typeorm';
import { AddPlanningPermissions1786100000000 } from './infrastructure/database/migrations/1786100000000-AddPlanningPermissions';
const ds = new DataSource({ type:'postgres', host:process.env.DB_HOST||'postgres', port:5432,
  username:'fapoms', password:'fapoms_dev', database:'fapoms', synchronize:false, logging:false, entities:[], migrations:[] });
async function main(){
  await ds.initialize(); const qr = ds.createQueryRunner(); await qr.connect();
  await qr.startTransaction();
  try { await new AddPlanningPermissions1786100000000().up(qr); await qr.commitTransaction(); console.log('Committed.'); }
  catch(e){ await qr.rollbackTransaction(); console.error('FAILED, rolled back:', e); process.exitCode=1; }
  console.table(await qr.query(`
    SELECT r.name AS role, p.action, p.scope FROM roles r
    JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id
    WHERE p.resource='PLANNING' ORDER BY r.name, p.action`));
  await qr.release(); await ds.destroy();
}
main().catch(e=>{console.error(e);process.exit(1);});
